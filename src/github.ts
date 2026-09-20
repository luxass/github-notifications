import { Context, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const API_ROOT = "https://api.github.com";

const API_VERSION = "2022-11-28";

const PER_PAGE = 50;

const DEFAULT_POLL_INTERVAL_SECONDS = 60;

const POLL_INTERVAL_BUFFER_MS = 5_000;

const ERROR_BODY_LIMIT = 2_000;

export const GitHubNotification = Schema.Struct({
  id: Schema.String,
  unread: Schema.Boolean,
  reason: Schema.String,
  updated_at: Schema.String,
  last_read_at: Schema.NullOr(Schema.String),
  repository: Schema.Struct({
    full_name: Schema.String,
  }),
  subject: Schema.Struct({
    title: Schema.String,
    type: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
});

export type GitHubNotification = Schema.Schema.Type<typeof GitHubNotification>;

const SubjectPayload = Schema.Struct({
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Struct({ login: Schema.String })),
  requested_reviewers: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  requested_teams: Schema.optional(Schema.Array(Schema.Struct({ slug: Schema.String }))),
});

const SUBJECT_CACHE_LIMIT = 2000;

export interface SubjectDetails {
  readonly state: string;
  readonly merged: boolean;
  readonly author: string;
  readonly reviewPending: boolean;
}

export interface ListNotificationsOptions {
  readonly lastModified?: string;
}

export type ListNotificationsResult =
  | {
      readonly kind: "not-modified";
      readonly pollAfterMs: number;
      readonly lastModified?: string;
    }
  | {
      readonly kind: "updated";
      readonly notifications: GitHubNotification[];
      readonly pollAfterMs: number;
      readonly lastModified?: string;
      readonly truncated: boolean;
    };

export interface GitHubClientOptions {
  readonly token: string;
  readonly maxPages?: number;
}

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()(
  "GitHubRequestError",
  {
    message: Schema.String,
    status: Schema.Number,
    url: Schema.String,
    responseBody: Schema.String,
  },
) {}

export class GitHubPayloadError extends Schema.TaggedError<GitHubPayloadError>()(
  "GitHubPayloadError",
  { message: Schema.String },
) {}

export class GitHubNetworkError extends Schema.TaggedError<GitHubNetworkError>()(
  "GitHubNetworkError",
  { message: Schema.String, cause: Schema.Unknown },
) {}

export class GitHubClient extends Context.Service<
  GitHubClient,
  {
    readonly listNotifications: (
      options?: ListNotificationsOptions,
    ) => Effect.Effect<
      ListNotificationsResult,
      GitHubRequestError | GitHubPayloadError | GitHubNetworkError
    >;
    readonly markThreadRead: (
      threadId: string,
    ) => Effect.Effect<void, GitHubRequestError | GitHubNetworkError>;
    readonly markThreadDone: (
      threadId: string,
    ) => Effect.Effect<void, GitHubRequestError | GitHubNetworkError>;
    readonly deleteThreadSubscription: (
      threadId: string,
    ) => Effect.Effect<void, GitHubRequestError | GitHubNetworkError>;
    readonly getSubject: (
      url: string,
    ) => Effect.Effect<
      SubjectDetails | null,
      GitHubRequestError | GitHubPayloadError | GitHubNetworkError
    >;
  }
>()("github-notifications/GitHubClient") {}

export const GitHubClientLive = (options: GitHubClientOptions) =>
  Layer.effect(
    GitHubClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const maxPages = options.maxPages ?? 5;

      if (options.token.trim().length === 0) {
        return yield* Effect.fail(
          new GitHubNetworkError({
            message: "GitHub client token cannot be empty",
            cause: options,
          }),
        );
      }

      const baseHeaders = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "user-agent": "github-notifications",
        "x-github-api-version": API_VERSION,
      };

      const subjectCache = new Map<string, { etag: string; details: SubjectDetails }>();

      const mutateThread = (
        method: "PATCH" | "DELETE",
        path: string,
        expectedStatus: number,
        toleratedStatuses: ReadonlyArray<number> = [],
      ): Effect.Effect<void, GitHubRequestError | GitHubNetworkError> =>
        Effect.gen(function* () {
          const url = new URL(path, API_ROOT);

          const request =
            method === "PATCH"
              ? httpClient.patch(url, { headers: baseHeaders })
              : httpClient.del(url, { headers: baseHeaders });

          const response = yield* request.pipe(
            Effect.mapError(
              (cause) =>
                new GitHubNetworkError({
                  message: `GitHub ${method} ${url.toString()} failed`,
                  cause,
                }),
            ),
          );

          if (response.status === expectedStatus || toleratedStatuses.includes(response.status)) {
            return;
          }

          const body = (yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new GitHubNetworkError({
                  message: `GitHub ${method} ${url.toString()} failed while reading the response`,
                  cause,
                }),
            ),
          )).slice(0, ERROR_BODY_LIMIT);

          yield* Effect.fail(
            new GitHubRequestError({
              status: response.status,
              url: url.toString(),
              responseBody: body,
              message: `GitHub ${method} ${url.toString()} failed with ${response.status}${body ? `: ${body}` : ""}`,
            }),
          );
        });

      const markThreadRead = (threadId: string) =>
        mutateThread("PATCH", `/notifications/threads/${threadId}`, 205, [304]);

      const markThreadDone = (threadId: string) =>
        mutateThread("DELETE", `/notifications/threads/${threadId}`, 204, [404]);

      const deleteThreadSubscription = (threadId: string) =>
        mutateThread("DELETE", `/notifications/threads/${threadId}/subscription`, 204, [404]);

      const getSubject = (
        url: string,
      ): Effect.Effect<
        SubjectDetails | null,
        GitHubRequestError | GitHubPayloadError | GitHubNetworkError
      > =>
        Effect.gen(function* () {
          const cached = subjectCache.get(url);

          const headers =
            cached === undefined ? baseHeaders : { ...baseHeaders, "if-none-match": cached.etag };

          const response = yield* httpClient.get(url, { headers }).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubNetworkError({
                  message: `GitHub GET ${url} failed`,
                  cause,
                }),
            ),
          );

          if (response.status === 304 && cached !== undefined) {
            return cached.details;
          }

          if (response.status === 404) {
            return null;
          }

          if (response.status < 200 || response.status >= 300) {
            const body = (yield* response.text.pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubNetworkError({
                    message: `GitHub GET ${url} failed while reading the response`,
                    cause,
                  }),
              ),
            )).slice(0, ERROR_BODY_LIMIT);

            return yield* Effect.fail(
              new GitHubRequestError({
                status: response.status,
                url,
                responseBody: body,
                message: `GitHub GET ${url} failed with ${response.status}${body ? `: ${body}` : ""}`,
              }),
            );
          }

          const payload = yield* HttpClientResponse.schemaBodyJson(SubjectPayload)(response).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubPayloadError({
                  message: `GitHub subject response did not match the expected schema: ${String(cause)}`,
                }),
            ),
          );

          const login = payload.user?.login ?? "unknown";
          const author = login.endsWith("[bot]") ? login.slice(0, -5) : login;

          const details = {
            state: payload.state,
            merged: payload.merged ?? false,
            author,
            reviewPending:
              (payload.requested_reviewers?.length ?? 0) + (payload.requested_teams?.length ?? 0) >
              0,
          };

          const etag = response.headers["etag"];

          if (etag !== undefined) {
            if (subjectCache.size >= SUBJECT_CACHE_LIMIT) {
              subjectCache.clear();
            }

            subjectCache.set(url, { etag, details });
          }

          return details;
        });

      const listNotifications = (requestOptions: ListNotificationsOptions = {}) =>
        Effect.gen(function* () {
          const notifications: GitHubNotification[] = [];
          let pollAfterMs = DEFAULT_POLL_INTERVAL_SECONDS * 1_000 + POLL_INTERVAL_BUFFER_MS;
          let lastModified: string | undefined;

          for (let page = 1; page <= maxPages; page++) {
            const url = new URL("/notifications", API_ROOT);
            url.searchParams.set("all", "true");
            url.searchParams.set("participating", "false");
            url.searchParams.set("per_page", String(PER_PAGE));
            url.searchParams.set("page", String(page));

            const headers =
              page === 1 && requestOptions.lastModified !== undefined
                ? {
                    accept: "application/vnd.github+json",
                    authorization: `Bearer ${options.token}`,
                    "user-agent": "github-notifications",
                    "x-github-api-version": API_VERSION,
                    "if-modified-since": requestOptions.lastModified,
                  }
                : {
                    accept: "application/vnd.github+json",
                    authorization: `Bearer ${options.token}`,
                    "user-agent": "github-notifications",
                    "x-github-api-version": API_VERSION,
                  };

            const response = yield* httpClient
              .get(url, {
                headers,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new GitHubNetworkError({
                      message: `GitHub GET ${url.toString()} failed`,
                      cause,
                    }),
                ),
              );

            if (page === 1) {
              pollAfterMs = parsePollInterval(response.headers["x-poll-interval"] ?? null);
              lastModified = response.headers["last-modified"];
            }

            if (response.status === 304) {
              if (page !== 1) {
                return yield* Effect.fail(
                  new GitHubPayloadError({
                    message: "GitHub returned 304 for a paginated request",
                  }),
                );
              }

              return withOptionalLastModified({ kind: "not-modified", pollAfterMs }, lastModified);
            }

            if (response.status < 200 || response.status >= 300) {
              const body = (yield* response.text.pipe(
                Effect.mapError(
                  (cause) =>
                    new GitHubNetworkError({
                      message: `GitHub GET ${url.toString()} failed while reading the response`,
                      cause,
                    }),
                ),
              )).slice(0, ERROR_BODY_LIMIT);

              return yield* Effect.fail(
                new GitHubRequestError({
                  status: response.status,
                  url: url.toString(),
                  responseBody: body,
                  message: `GitHub GET ${url.toString()} failed with ${response.status}${body ? `: ${body}` : ""}`,
                }),
              );
            }

            const pageNotifications = yield* parseNotificationPage(response);
            notifications.push(...pageNotifications);

            if (pageNotifications.length < PER_PAGE) {
              return withOptionalLastModified(
                { kind: "updated", notifications, pollAfterMs, truncated: false },
                lastModified,
              );
            }
          }

          return withOptionalLastModified(
            { kind: "updated", notifications, pollAfterMs, truncated: true },
            lastModified,
          );
        });

      return GitHubClient.of({
        listNotifications,
        markThreadRead,
        markThreadDone,
        deleteThreadSubscription,
        getSubject,
      });
    }),
  );

function parseNotificationPage(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const payload = yield* HttpClientResponse.schemaBodyJson(Schema.Array(GitHubNotification))(
      response,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubPayloadError({
            message: `GitHub notifications response did not match the expected schema: ${String(cause)}`,
          }),
      ),
    );

    return payload;
  });
}

function withOptionalLastModified<
  TResult extends { kind: "not-modified" | "updated"; pollAfterMs: number },
>(result: TResult, lastModified: string | undefined) {
  return lastModified === undefined ? result : { ...result, lastModified };
}

function parsePollInterval(value: string | null) {
  const seconds = value === null ? 60 : Number(value);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;

  return safeSeconds * 1_000 + POLL_INTERVAL_BUFFER_MS;
}
