import { describe, expect, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  RuleActionExecutor,
  RuleActionExecutorLive,
  compileRules,
  executeRules,
} from "../../src/dsl/compiler.ts";
import { GitHubClient } from "../../src/github.ts";
import { makeMentionEnv, makeQuietEnv } from "./helpers.ts";

describe("rule engine", () => {
  test("all matching rules run in order and report their names", () => {
    const rules = Effect.runSync(
      compileRules([
        { name: "mentions", when: 'notification.reason == "mention"', actions: [{ type: "read" }] },
        { name: "bots", when: 'author.type == "Bot"', actions: [{ type: "unread" }] },
        {
          name: "digest",
          when: 'notification.reason == "subscribed"',
          actions: [{ type: "done" }],
        },
      ]),
    );
    const seen: unknown[] = [];
    const matched = Effect.runSync(
      executeRules(rules, makeMentionEnv(), {
        execute: (action) => {
          seen.push(action);
          return Effect.void;
        },
      }),
    );

    expect(matched).toEqual(["mentions", "bots"]);
    expect(seen).toEqual([{ type: "read" }, { type: "unread" }]);
  });

  test("stop defaults to false and halts later rules", () => {
    const rules = Effect.runSync(
      compileRules([
        {
          name: "first",
          when: "notification.unread == true",
          actions: [{ type: "done" }],
          stop: true,
        },
        { name: "second", when: "repo.stars > 1", actions: [{ type: "read" }] },
      ]),
    );

    expect(rules[0]?.stop).toBe(true);
    expect(rules[1]?.stop).toBe(false);

    const seen: unknown[] = [];
    const matched = Effect.runSync(
      executeRules(rules, makeMentionEnv(), {
        execute: (action) => {
          seen.push(action);
          return Effect.void;
        },
      }),
    );

    expect(matched).toEqual(["first"]);
    expect(seen).toEqual([{ type: "done" }]);
  });

  test("an environment matching nothing runs no actions", () => {
    const rules = Effect.runSync(
      compileRules([
        { name: "mentions", when: 'notification.reason == "mention"', actions: [{ type: "read" }] },
      ]),
    );
    const seen: unknown[] = [];
    const matched = Effect.runSync(
      executeRules(rules, makeQuietEnv(), {
        execute: (action) => {
          seen.push(action);
          return Effect.void;
        },
      }),
    );

    expect(matched).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("a bad when fails during compilation", () => {
    expect(() =>
      Effect.runSync(
        compileRules([{ name: "bad", when: "banana.reason == 1", actions: [{ type: "read" }] }]),
      ),
    ).toThrow();
  });

  test("live executor dispatches mutations to the GitHub client", () => {
    const calls: Array<{ method: string; threadId: string }> = [];
    const githubLayer = Layer.succeed(GitHubClient, {
      listNotifications: () => Effect.die("unused"),
      getSubject: () => Effect.succeed(null),
      markThreadRead: (threadId) =>
        Effect.sync(() => {
          calls.push({ method: "read", threadId });
        }),
      markThreadDone: (threadId) =>
        Effect.sync(() => {
          calls.push({ method: "done", threadId });
        }),
      deleteThreadSubscription: (threadId) =>
        Effect.sync(() => {
          calls.push({ method: "unsubscribe", threadId });
        }),
    });
    const layer = RuleActionExecutorLive.pipe(Layer.provide(githubLayer));

    Effect.runSync(
      Effect.gen(function* () {
        const executor = yield* RuleActionExecutor;
        const environment = makeMentionEnv();
        yield* executor.execute({ type: "read" }, environment);
        yield* executor.execute({ type: "done" }, environment);
        yield* executor.execute({ type: "unsubscribe" }, environment);
        yield* executor.execute({ type: "unread" }, environment);
      }).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual([
      { method: "read", threadId: "1001" },
      { method: "done", threadId: "1001" },
      { method: "unsubscribe", threadId: "1001" },
    ]);
  });
});
