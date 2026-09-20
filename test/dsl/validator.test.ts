import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { ValidationError } from "../../src/dsl/errors.ts";
import { parse as parseEffect } from "../../src/dsl/parser.ts";
import { validate as validateEffect } from "../../src/dsl/validator.ts";

function check(source: string): void {
  Effect.runSync(validateEffect(Effect.runSync(parseEffect(source))));
}

function checkThrows(source: string): void {
  expect(() => check(source)).toThrow(ValidationError);
}

describe("validate", () => {
  test("every schema field accepts a fitting comparison", () => {
    expect(() =>
      check(`
        notification.id == "1001"
        and notification.reason == "mention"
        and notification.unread == true
        and notification.title contains "security"
        and notification.type == "PullRequest"
        and notification.updatedAt > "2026-09-01T00:00:00.000Z"
        and repo.name == "github-notifications"
        and repo.owner == "lucasnorgard"
        and repo.fullName contains "github"
        and repo.private == false
        and repo.stars >= 10
        and author.login == "dependabot"
        and author.type != "User"
        and ctx.login == "lucasnorgard"
        and subject.state == "open"
        and subject.merged == false
        and subject.author == "dependabot"
        and subject.reviewPending == false
      `),
    ).not.toThrow();
  });

  test("bare boolean fields are valid conditions", () => {
    expect(() => check("notification.unread")).not.toThrow();
    expect(() => check("not repo.private")).not.toThrow();
    expect(() => check("notification.unread and repo.stars > 1")).not.toThrow();
  });

  test("member-to-member comparisons validate", () => {
    expect(() => check("repo.owner == ctx.login")).not.toThrow();
  });

  test("unknown roots and fields are rejected", () => {
    checkThrows("banana.reason == 1");
    try {
      check("banana.reason == 1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      // SAFETY: ValidationError is an Error subclass and exposes message.
      expect((error as Error).message).toContain("banana");
    }
    checkThrows("notification.whatever == 1");
    checkThrows("repo.owner.name == 1");
    checkThrows("ctx == 1");
  });

  test("namespaces used as values are rejected", () => {
    checkThrows("repo == 1");
    checkThrows("notification == 1");
    checkThrows("author == 1");
  });

  test("`contains` is strings-only", () => {
    checkThrows('repo.stars contains "4"');
    checkThrows('notification.unread contains "true"');
    checkThrows('notification.updatedAt contains "2026"');
    checkThrows('repo.private contains "x"');
  });

  test("ordering operators are numbers-and-dates-only", () => {
    checkThrows("notification.title > 5");
    checkThrows("notification.reason >= 5");
    checkThrows("notification.unread > 1");
    checkThrows("repo.private < 1");
    checkThrows("author.login <= 1");
    expect(() => check("repo.stars > 1")).not.toThrow();
    expect(() => check('notification.updatedAt < "2026-09-20T00:00:00.000Z"')).not.toThrow();
  });

  test("the left side of a comparison must be a field", () => {
    checkThrows('"mention" == notification.reason');
    checkThrows("1 < 2");
    checkThrows("true == notification.unread");
  });

  test("bare non-boolean fields and bare literals are rejected", () => {
    checkThrows("notification.title");
    checkThrows("repo.stars");
    checkThrows("notification.updatedAt");
    checkThrows("true");
    checkThrows("42");
    checkThrows("not true");
  });
});
