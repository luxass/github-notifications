import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { compilePredicate as compilePredicateEffect } from "../../src/dsl/compiler.ts";
import { ParseError, TokenizeError, ValidationError } from "../../src/dsl/errors.ts";
import { parse as parseEffect } from "../../src/dsl/parser.ts";
import { makeMentionEnv, makeQuietEnv } from "./helpers.ts";

const compilePredicate = (source: string) => Effect.runSync(compilePredicateEffect(source));

describe("compilePredicate", () => {
  test("compiles and matches across environments", () => {
    const source = 'notification.reason == "mention" and not repo.private';
    const expression = Effect.runSync(parseEffect(source));
    expect(expression).toEqual({
      type: "logical",
      operator: "and",
      left: {
        type: "comparison",
        operator: "==",
        left: { type: "member", path: ["notification", "reason"] },
        right: { type: "literal", value: "mention" },
      },
      right: {
        type: "unary",
        operator: "not",
        expression: { type: "member", path: ["repo", "private"] },
      },
    });
    const matches = compilePredicate(source);
    expect(Effect.runSync(matches(makeMentionEnv()))).toBe(true);
    expect(Effect.runSync(matches(makeQuietEnv()))).toBe(false);
  });

  test("compiled predicates are reusable", () => {
    const matches = compilePredicate("repo.stars > 10");
    expect(Effect.runSync(matches(makeMentionEnv()))).toBe(true);
    expect(Effect.runSync(matches(makeMentionEnv()))).toBe(true);
    expect(Effect.runSync(matches(makeQuietEnv()))).toBe(false);
  });

  test("bad input surfaces the right error class", () => {
    expect(() => compilePredicate("notification.reason @ 1")).toThrow(TokenizeError);
    expect(() => compilePredicate("notification.reason ==")).toThrow(ParseError);
    expect(() => compilePredicate("banana.reason == 1")).toThrow(ValidationError);
    expect(() => compilePredicate("notification.title > 5")).toThrow(ValidationError);
  });
});
