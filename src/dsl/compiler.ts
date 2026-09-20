import { Context, Effect, Layer, Match } from "effect";

import type { Action, Rule } from "../config.ts";
import { GitHubClient } from "../github.ts";
import type { QueryEnvironment } from "./environment.ts";
import type { ParseError, TokenizeError, ValidationError } from "./errors.ts";
import { compileExpression, type QueryPredicate } from "./evaluator.ts";
import { parse } from "./parser.ts";
import { validate } from "./validator.ts";

export const compilePredicate = Effect.fn("dsl.compilePredicate")(function* (
  source: string,
): Effect.fn.Return<QueryPredicate, TokenizeError | ParseError | ValidationError> {
  const expression = yield* parse(source);
  yield* validate(expression);

  return compileExpression(expression);
});

export interface CompiledRule {
  readonly name: string;
  readonly predicate: QueryPredicate;
  readonly actions: ReadonlyArray<Action>;
  readonly stop: boolean;
}

export class RuleActionExecutor extends Context.Service<
  RuleActionExecutor,
  {
    readonly execute: (action: Action, environment: QueryEnvironment) => Effect.Effect<void, Error>;
  }
>()("github-notifications/RuleActionExecutor") {}

export const RuleActionExecutorLive = Layer.effect(
  RuleActionExecutor,
  Effect.gen(function* () {
    const client = yield* GitHubClient;

    return RuleActionExecutor.of({
      execute: (action, environment) =>
        Effect.gen(function* () {
          yield* Effect.log(
            JSON.stringify({
              event: "rule_action",
              action,
              notification: environment.notification.title,
              thread: environment.notification.id,
            }),
          );

          yield* Match.value(action).pipe(
            Match.when({ type: "read" }, () => client.markThreadRead(environment.notification.id)),
            Match.when({ type: "done" }, () => client.markThreadDone(environment.notification.id)),
            Match.when({ type: "unsubscribe" }, () =>
              client.deleteThreadSubscription(environment.notification.id),
            ),
            Match.when({ type: "unread" }, () =>
              Effect.logWarning("Skipping unread action: GitHub has no mark-unread endpoint"),
            ),
            Match.exhaustive,
          );
        }),
    });
  }),
);

export const compileRules = Effect.fn("dsl.compileRules")(function* (
  definitions: ReadonlyArray<Rule>,
) {
  return yield* Effect.forEach(definitions, (definition) =>
    Effect.gen(function* () {
      return {
        name: definition.name,
        predicate: yield* compilePredicate(definition.when),
        actions: definition.actions,
        stop: definition.stop ?? false,
      };
    }),
  );
});

export const executeRules = Effect.fn("dsl.executeRules")(function* (
  rules: ReadonlyArray<CompiledRule>,
  environment: QueryEnvironment,
  executor: RuleActionExecutor["Service"],
) {
  const run = (
    remaining: ReadonlyArray<CompiledRule>,
    matched: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, Error> =>
    Effect.gen(function* () {
      const [rule, ...rest] = remaining;

      if (rule === undefined) {
        return matched;
      }

      if (!(yield* rule.predicate(environment))) {
        return yield* run(rest, matched);
      }

      yield* Effect.forEach(rule.actions, (action) => executor.execute(action, environment));

      if (rule.stop) {
        return [...matched, rule.name];
      }

      return yield* run(rest, [...matched, rule.name]);
    });

  return yield* run(rules, []);
});
