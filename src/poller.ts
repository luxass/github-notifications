import { Context, Duration, Effect, Layer } from "effect";

import { executeRulesLazily, type CompiledRule, RuleActionExecutor } from "./dsl/compiler.ts";
import type { QueryEnvironment, Subject } from "./dsl/environment.ts";
import { GitHubClient, type GitHubNotification } from "./github.ts";

export type PollTrigger = "startup" | "schedule";

export class NotificationPoller extends Context.Service<
  NotificationPoller,
  {
    readonly poll: (trigger: PollTrigger) => Effect.Effect<void, Error>;
  }
>()("github-notifications/NotificationPoller") {}

export const NotificationPollerLive = (rules: ReadonlyArray<CompiledRule>) =>
  Layer.effect(
    NotificationPoller,
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      const executor = yield* RuleActionExecutor;
      let lastModified: string | undefined;
      let nextPollAt = 0;

      return NotificationPoller.of({
        poll: (trigger) =>
          Effect.gen(function* () {
            const waitMs = Math.max(0, nextPollAt - Date.now());

            if (waitMs > 0) {
              yield* Effect.sleep(Duration.millis(waitMs));
            }

            yield* Effect.log(`Polling GitHub (${trigger})`);
            const startedAt = Date.now();
            const result = yield* client.listNotifications({ lastModified });
            nextPollAt = Date.now() + result.pollAfterMs;

            if (result.lastModified !== undefined) {
              lastModified = result.lastModified;
            }

            if (result.kind === "not-modified") {
              yield* Effect.log(`No new notifications (${trigger})`);

              return;
            }

            const matchedCounts = yield* Effect.forEach(
              result.notifications,
              (notification) =>
                Effect.gen(function* () {
                  const environment = toQueryEnvironment(notification, SUBJECT_DEFAULTS);

                  const matchedRules = yield* executeRulesLazily(
                    rules,
                    environment,
                    () => loadSubjectEnvironment(client, notification),
                    executor,
                  );

                  if (matchedRules.length > 0) {
                    yield* Effect.log(
                      JSON.stringify({ event: "rules_matched", rules: matchedRules }),
                    );
                  }

                  return matchedRules.length;
                }),
              { concurrency: 10 },
            );

            const matchedRules = matchedCounts.reduce((total, count) => total + count, 0);

            const unread = result.notifications.filter(
              (notification) => notification.unread,
            ).length;

            yield* Effect.log(
              JSON.stringify({
                event: "poll_complete",
                trigger,
                notifications: result.notifications.length,
                unread,
                matchedRules,
                truncated: result.truncated,
                durationMs: Date.now() - startedAt,
              }),
            );
          }),
      });
    }),
  );

function toQueryEnvironment(notification: GitHubNotification, subject: Subject): QueryEnvironment {
  const [owner = "unknown", name = "unknown"] = notification.repository.full_name.split("/", 2);

  return {
    notification: {
      id: notification.id,
      reason: notification.reason,
      unread: notification.unread,
      title: notification.subject.title,
      type: notification.subject.type,
      updatedAt: new Date(notification.updated_at),
    },
    repo: {
      name,
      owner,
      fullName: notification.repository.full_name,
      private: false,
      stars: 0,
    },
    author: { login: subject.author, type: "unknown" },
    ctx: { login: "unknown" },
    subject,
  };
}

function loadSubjectEnvironment(
  client: GitHubClient["Service"],
  notification: GitHubNotification,
): Effect.Effect<QueryEnvironment, Error> {
  const url = notification.subject.url;

  const supportedType =
    notification.subject.type === "Issue" || notification.subject.type === "PullRequest";

  const fetched =
    url === null || !supportedType
      ? Effect.succeed(SUBJECT_DEFAULTS)
      : client.getSubject(url).pipe(
          Effect.map((details) => details ?? SUBJECT_DEFAULTS),
          Effect.catch(() =>
            Effect.logWarning(`Could not fetch subject for thread ${notification.id}`).pipe(
              Effect.as(SUBJECT_DEFAULTS),
            ),
          ),
        );

  return Effect.map(fetched, (subject) => toQueryEnvironment(notification, subject));
}

const SUBJECT_DEFAULTS: Subject = {
  state: "unknown",
  merged: false,
  author: "unknown",
  reviewPending: false,
};
