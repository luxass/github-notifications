import { createServer } from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Cron, DateTime, Effect, Layer, Result, Schedule } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ConfigValueError, loadConfig } from "./config.ts";
import { compileRules, RuleActionExecutorLive } from "./dsl/compiler.ts";
import { GitHubClientLive } from "./github.ts";
import { NotificationPoller, NotificationPollerLive } from "./poller.ts";

const program = Effect.gen(function* () {
  const config = yield* loadConfig();
  const token = process.env[config.github.tokenEnv];

  if (token === undefined || token.trim().length === 0) {
    return yield* Effect.fail(
      new ConfigValueError({
        message: `Environment variable ${config.github.tokenEnv} is required`,
      }),
    );
  }

  const scheduleResult = Cron.parse(config.server.schedule, DateTime.zoneMakeNamedUnsafe("UTC"));

  if (!Result.isSuccess(scheduleResult)) {
    return yield* Effect.fail(
      new ConfigValueError({
        message: `Invalid cron schedule: ${scheduleResult.failure.message}`,
      }),
    );
  }

  const rules = yield* compileRules(config.rules);

  const githubLayer = GitHubClientLive({ token, maxPages: config.github.maxPages }).pipe(
    Layer.provide(NodeHttpClient.layerUndici),
  );

  const pollerLayer = NotificationPollerLive(rules).pipe(
    Layer.provide(RuleActionExecutorLive),
    Layer.provide(githubLayer),
  );

  const poll = (trigger: "startup" | "schedule") =>
    Effect.gen(function* () {
      const poller = yield* NotificationPoller;
      yield* poller.poll(trigger);
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(
          `${trigger} poll failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
      Effect.provide(pollerLayer),
    );

  yield* poll("startup");
  yield* Effect.repeat(poll("schedule"), Schedule.cron(scheduleResult.success)).pipe(
    Effect.forkChild,
  );

  const httpApp = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/") {
      return yield* HttpServerResponse.json({
        name: "github-notifications",
        status: "ok",
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return yield* HttpServerResponse.json({ status: "healthy" });
    }

    return yield* HttpServerResponse.json({ error: "not_found" }, { status: 404 });
  });

  yield* Effect.log(`HTTP server listening on http://${config.server.host}:${config.server.port}`);
  yield* Layer.launch(
    HttpServer.serve(httpApp).pipe(
      Layer.provide(
        NodeHttpServer.layer(() => createServer(), {
          host: config.server.host,
          port: config.server.port,
        }),
      ),
    ),
  );

  return yield* Effect.void;
});

Effect.runPromise(program).catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
