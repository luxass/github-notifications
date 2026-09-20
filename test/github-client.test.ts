import { describe, expect, test } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  GitHubClient,
  GitHubClientLive,
  GitHubPayloadError,
  type ListNotificationsOptions,
} from "../src/github.ts";

function makeClient(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
  maxPages = 5,
) {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
  );
  const layer = GitHubClientLive({ token: "test-token", maxPages }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
  );

  return (options?: ListNotificationsOptions) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return yield* client.listNotifications(options);
      }).pipe(Effect.provide(layer)),
    );
}

function withClient(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
  );
  const layer = GitHubClientLive({ token: "test-token" }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
  );

  return <A, E>(task: (client: GitHubClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return yield* task(client);
      }).pipe(Effect.provide(layer)),
    );
}

describe("GitHubClient", () => {
  test("lists and validates notifications with read-only GET", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const list = makeClient((incoming) => {
      request = incoming;
      return Response.json([rawNotification("1")], {
        headers: {
          "last-modified": "Sat, 19 Sep 2026 10:00:00 GMT",
          "x-poll-interval": "120",
        },
      });
    });

    await expect(list()).resolves.toMatchObject({
      kind: "updated",
      notifications: [notification("1")],
      lastModified: "Sat, 19 Sep 2026 10:00:00 GMT",
      pollAfterMs: 125_000,
      truncated: false,
    });
    expect(request?.method).toBe("GET");
    expect(request?.headers.authorization).toBe("Bearer test-token");
    expect(request?.url).toContain("/notifications");
  });

  test("uses If-Modified-Since and handles 304", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const list = makeClient((incoming) => {
      request = incoming;
      return new Response(null, { status: 304, headers: { "x-poll-interval": "60" } });
    });

    await expect(list({ lastModified: "Sat, 19 Sep 2026 10:00:00 GMT" })).resolves.toEqual({
      kind: "not-modified",
      pollAfterMs: 65_000,
    });
    expect(request?.headers["if-modified-since"]).toBe("Sat, 19 Sep 2026 10:00:00 GMT");
  });

  test("paginates and reports a configured page cap", async () => {
    const requestedPages: string[] = [];
    const list = makeClient((request) => {
      const page =
        request.urlParams.params.find(([key]: readonly [string, string]) => key === "page")?.[1] ??
        "";
      requestedPages.push(page);
      return Response.json(
        Array.from({ length: 50 }, (_, index) => rawNotification(`${page}-${index}`)),
      );
    }, 2);

    const result = await list();

    expect(requestedPages).toEqual(["1", "2"]);
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.notifications).toHaveLength(100);
      expect(result.truncated).toBe(true);
    }
  });

  test("rejects malformed response payloads at the boundary", async () => {
    const list = makeClient(() => Response.json([{ id: 123 }]));

    await expect(list()).rejects.toBeInstanceOf(GitHubPayloadError);
  });

  test("reports HTTP errors without exposing the token", async () => {
    const list = makeClient(() => new Response("denied", { status: 401 }));

    await expect(list()).rejects.toMatchObject({
      status: 401,
      responseBody: "denied",
    } satisfies { status: number; responseBody: string });
  });

  test("marks a thread as read with PATCH", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const run = withClient((incoming) => {
      request = incoming;
      return new Response(null, { status: 205 });
    });

    await expect(run((client) => client.markThreadRead("42"))).resolves.toBeUndefined();
    expect(request?.method).toBe("PATCH");
    expect(request?.url).toBe("https://api.github.com/notifications/threads/42");
    expect(request?.headers.authorization).toBe("Bearer test-token");
  });

  test("treats 304 as an already-read thread", async () => {
    const run = withClient(() => new Response(null, { status: 304 }));

    await expect(run((client) => client.markThreadRead("42"))).resolves.toBeUndefined();
  });

  test("marks a thread as done with DELETE", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const run = withClient((incoming) => {
      request = incoming;
      return new Response(null, { status: 204 });
    });

    await expect(run((client) => client.markThreadDone("42"))).resolves.toBeUndefined();
    expect(request?.method).toBe("DELETE");
    expect(request?.url).toBe("https://api.github.com/notifications/threads/42");
  });

  test("deletes a thread subscription with DELETE", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const run = withClient((incoming) => {
      request = incoming;
      return new Response(null, { status: 204 });
    });

    await expect(run((client) => client.deleteThreadSubscription("42"))).resolves.toBeUndefined();
    expect(request?.method).toBe("DELETE");
    expect(request?.url).toBe("https://api.github.com/notifications/threads/42/subscription");
  });

  test("treats 404 on done and unsubscribe as idempotent success", async () => {
    const run = withClient(() => new Response(null, { status: 404 }));

    await expect(run((client) => client.markThreadDone("42"))).resolves.toBeUndefined();
    await expect(run((client) => client.deleteThreadSubscription("42"))).resolves.toBeUndefined();
  });

  test("fetches and decodes a pull request subject", async () => {
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const run = withClient((incoming) => {
      request = incoming;
      return Response.json({
        state: "open",
        merged: false,
        user: { login: "dependabot[bot]" },
        requested_reviewers: [{ login: "lucasnorgard" }],
        requested_teams: [],
      });
    });

    await expect(
      run((client) => client.getSubject("https://api.github.com/repos/a/b/pulls/1")),
    ).resolves.toEqual({
      state: "open",
      merged: false,
      author: "dependabot",
      reviewPending: true,
    });
    expect(request?.method).toBe("GET");
  });

  test("resolves a missing subject as null", async () => {
    const run = withClient(() => new Response(null, { status: 404 }));

    await expect(
      run((client) => client.getSubject("https://api.github.com/repos/a/b/pulls/1")),
    ).resolves.toBeNull();
  });

  test("caches subjects with etags and serves 304 from cache", async () => {
    const seenHeaders: Array<Record<string, string | undefined>> = [];
    const run = withClient((incoming) => {
      seenHeaders.push({ ...incoming.headers });
      if (incoming.headers["if-none-match"] === '"abc123"') {
        return new Response(null, { status: 304 });
      }
      return Response.json(
        {
          state: "closed",
          user: { login: "octocat" },
        },
        { headers: { etag: '"abc123"' } },
      );
    });
    const url = "https://api.github.com/repos/a/b/issues/1";

    const both = await run((client) =>
      Effect.gen(function* () {
        const first = yield* client.getSubject(url);
        const second = yield* client.getSubject(url);
        return [first, second];
      }),
    );

    expect(both).toEqual([
      { state: "closed", merged: false, author: "octocat", reviewPending: false },
      { state: "closed", merged: false, author: "octocat", reviewPending: false },
    ]);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[1]?.["if-none-match"]).toBe('"abc123"');
  });

  test("reports mutation failures with status and body", async () => {
    const run = withClient(() => new Response("forbidden", { status: 403 }));

    await expect(run((client) => client.markThreadRead("42"))).rejects.toMatchObject({
      status: 403,
      responseBody: "forbidden",
    } satisfies { status: number; responseBody: string });
  });
});

function rawNotification(id: string) {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-09-19T10:00:00Z",
    last_read_at: null,
    repository: { full_name: "luxass/cloudflare-workers" },
    subject: {
      title: "Review production polling",
      type: "PullRequest",
      url: null,
    },
  };
}

function notification(id: string) {
  return {
    id,
    unread: true,
    reason: "mention",
    updated_at: "2026-09-19T10:00:00Z",
    last_read_at: null,
    repository: { full_name: "luxass/cloudflare-workers" },
    subject: {
      title: "Review production polling",
      type: "PullRequest",
      url: null,
    },
  };
}
