import { readFile } from "node:fs/promises";

import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";

export class ConfigReadError extends Schema.TaggedError<ConfigReadError>()("ConfigReadError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.Unknown,
}) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
  message: Schema.String,
  path: Schema.String,
}) {}

export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

export const Action = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("read"),
  }),
  Schema.Struct({
    type: Schema.Literal("unread"),
  }),
  Schema.Struct({
    type: Schema.Literal("unsubscribe"),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
  }),
]);

export const Rule = Schema.Struct({
  name: Schema.String,
  when: Schema.String,
  actions: Schema.Array(Action),
  stop: Schema.optional(Schema.Boolean),
});

export const Config = Schema.Struct({
  server: Schema.Struct({
    host: Schema.Union([
      Schema.Literal("127.0.0.1"),
      Schema.Literal("localhost"),
      Schema.Literal("::1"),
    ]),
    port: Schema.Number,
    schedule: Schema.String,
  }),
  github: Schema.Struct({
    tokenEnv: Schema.String,
    maxPages: Schema.Number,
  }),
  rules: Schema.Array(Rule),
});

export type Action = Schema.Schema.Type<typeof Action>;

export type Rule = Schema.Schema.Type<typeof Rule>;

export type Config = Schema.Schema.Type<typeof Config>;

export const loadConfig = (path = process.env.CONFIG_PATH ?? "config.yaml") =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new ConfigReadError({
          message: `Unable to read config file ${path}`,
          path,
          cause,
        }),
    });

    const document = parseDocument(source);

    if (document.errors.length > 0) {
      return yield* Effect.fail(
        new ConfigParseError({
          message: document.errors.map((error) => error.message).join("; "),
          path,
        }),
      );
    }

    return yield* Schema.decodeUnknownEffect(Config)(document.toJS());
  });
