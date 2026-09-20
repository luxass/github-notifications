import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { evaluate } from "../../src/dsl/evaluator.ts";
import { parse as parseEffect } from "../../src/dsl/parser.ts";
import { validate as validateEffect } from "../../src/dsl/validator.ts";
import { makeMentionEnv, makeQuietEnv } from "./helpers.ts";

function run(source: string, env = makeMentionEnv()): boolean {
  const expression = Effect.runSync(parseEffect(source));
  Effect.runSync(validateEffect(expression));
  return Effect.runSync(evaluate(expression, env));
}

describe("evaluate", () => {
  test("string equality", () => {
    expect(run('notification.reason == "mention"')).toBe(true);
    expect(run('notification.reason == "subscribed"')).toBe(false);
    expect(run('notification.reason != "subscribed"')).toBe(true);
    expect(run('repo.owner == "lucasnorgard"')).toBe(true);
  });

  test("numbers", () => {
    expect(run("repo.stars == 42")).toBe(true);
    expect(run("repo.stars > 10")).toBe(true);
    expect(run("repo.stars >= 42")).toBe(true);
    expect(run("repo.stars < 100")).toBe(true);
    expect(run("repo.stars <= 41")).toBe(false);
  });

  test("booleans, including bare fields", () => {
    expect(run("notification.unread == true")).toBe(true);
    expect(run("repo.private == false")).toBe(true);
    expect(run("repo.private != false")).toBe(false);
    expect(run("notification.unread")).toBe(true);
    expect(run("not notification.unread")).toBe(false);
    expect(run("not repo.private")).toBe(true);
  });

  test("`contains` is case-sensitive substring", () => {
    expect(run('notification.title contains "Security"')).toBe(true);
    expect(run('notification.title contains "security"')).toBe(false);
    expect(run('notification.reason contains "men"')).toBe(true);
    expect(run('notification.title contains "digest"')).toBe(false);
  });

  test("dates compare against ISO strings", () => {
    expect(run('notification.updatedAt == "2026-09-18T10:00:00.000Z"')).toBe(true);
    expect(run('notification.updatedAt == "2026-09-19T10:00:00.000Z"')).toBe(false);
    expect(run('notification.updatedAt > "2026-09-01T00:00:00.000Z"')).toBe(true);
    expect(run('notification.updatedAt < "2026-09-20T00:00:00.000Z"')).toBe(true);
    expect(run('notification.updatedAt <= "2026-09-18T10:00:00.000Z"')).toBe(true);
  });

  test("member-to-member comparison resolves both sides", () => {
    expect(run("repo.owner == ctx.login")).toBe(true);
    expect(run("repo.owner == ctx.login", makeQuietEnv())).toBe(false);
  });

  test("logic: and / or / not / nesting", () => {
    expect(run('notification.unread and author.type == "Bot"')).toBe(true);
    expect(run('notification.unread and author.type == "User"')).toBe(false);
    expect(run('notification.reason == "subscribed" or repo.stars > 10')).toBe(true);
    expect(run("not not notification.unread")).toBe(true);
    expect(
      run(
        '(notification.reason == "mention" or notification.reason == "review_requested") and repo.private == false',
      ),
    ).toBe(true);
  });

  test("complex rule-style condition", () => {
    expect(
      run(`notification.reason == "mention"
        and (
          notification.title contains "Security"
          or author.type == "Bot"
        )
        and not repo.private`),
    ).toBe(true);
  });

  test("quiet environment matches (almost) nothing", () => {
    const quiet = makeQuietEnv();
    expect(run('notification.reason == "mention"', quiet)).toBe(false);
    expect(run("notification.unread", quiet)).toBe(false);
    expect(run("repo.stars > 10", quiet)).toBe(false);
    expect(run('notification.reason == "subscribed"', quiet)).toBe(true);
    expect(run('author.type == "User"', quiet)).toBe(true);
  });
});
