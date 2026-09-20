import { describe, expect, test } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { RuleActionExecutor, compileRules } from "../src/dsl/compiler.ts";
import type { QueryEnvironment } from "../src/dsl/environment.ts";
import { GitHubClient, type GitHubNotification } from "../src/github.ts";
import { NotificationPoller, NotificationPollerLive } from "../src/poller.ts";

const notification: GitHubNotification = {
  id: "1",
  unread: true,
  reason: "mention",
  updated_at: "2026-09-19T10:00:00Z",
  last_read_at: null,
  repository: { full_name: "luxass/cloudflare-workers" },
  subject: { title: "Review production polling", type: "PullRequest", url: null },
};

describe("NotificationPoller", () => {
  test("polls GitHub and executes matching actions through services", async () => {
    const actions: string[] = [];
    const rules = await Effect.runPromise(
      compileRules([
        {
          name: "mentions",
          when: 'notification.reason == "mention"',
          actions: [{ type: "read" }],
        },
      ]),
    );
    const githubLayer = Layer.succeed(GitHubClient, {
      listNotifications: () =>
        Effect.succeed({
          kind: "updated" as const,
          notifications: [notification],
          pollAfterMs: 65_000,
          truncated: false,
        }),
      markThreadRead: () => Effect.void,
      markThreadDone: () => Effect.void,
      deleteThreadSubscription: () => Effect.void,
      getSubject: () => Effect.succeed(null),
    });
    const executor: RuleActionExecutor["Service"] = {
      execute: (action, _environment: QueryEnvironment) => {
        actions.push(action.type);
        return Effect.void;
      },
    };
    const layer = NotificationPollerLive(rules).pipe(
      Layer.provide(Layer.succeed(RuleActionExecutor, executor)),
      Layer.provide(githubLayer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const poller = yield* NotificationPoller;
        yield* poller.poll("startup");
      }).pipe(Effect.provide(layer)),
    );

    expect(actions).toEqual(["read"]);
  });

  test("does not execute actions for an unchanged poll", async () => {
    const actions: string[] = [];
    const rules = await Effect.runPromise(compileRules([]));
    const layer = NotificationPollerLive(rules).pipe(
      Layer.provide(
        Layer.succeed(RuleActionExecutor, {
          execute: (action) => {
            actions.push(action.type);
            return Effect.void;
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(GitHubClient, {
          listNotifications: () =>
            Effect.succeed({ kind: "not-modified" as const, pollAfterMs: 65_000 }),
          markThreadRead: () => Effect.void,
          markThreadDone: () => Effect.void,
          deleteThreadSubscription: () => Effect.void,
          getSubject: () => Effect.succeed(null),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const poller = yield* NotificationPoller;
        yield* poller.poll("schedule");
      }).pipe(Effect.provide(layer)),
    );

    expect(actions).toEqual([]);
  });
});
