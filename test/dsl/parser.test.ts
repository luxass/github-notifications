import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { ParseError } from "../../src/dsl/errors.ts";
import { parse as parseEffect } from "../../src/dsl/parser.ts";

const parse = (source: string) => Effect.runSync(parseEffect(source));

describe("parse", () => {
  test("single comparison produces exact AST", () => {
    expect(parse('notification.reason == "mention"')).toEqual({
      type: "comparison",
      operator: "==",
      left: { type: "member", path: ["notification", "reason"] },
      right: { type: "literal", value: "mention" },
    });
  });

  test("deep member paths and literal operands", () => {
    expect(parse("repo.stars >= 10")).toEqual({
      type: "comparison",
      operator: ">=",
      left: { type: "member", path: ["repo", "stars"] },
      right: { type: "literal", value: 10 },
    });
    expect(parse("repo.private == false")).toEqual({
      type: "comparison",
      operator: "==",
      left: { type: "member", path: ["repo", "private"] },
      right: { type: "literal", value: false },
    });
  });

  test("`and` binds tighter than `or`", () => {
    expect(parse("a == 1 or b == 2 and c == 3")).toEqual({
      type: "logical",
      operator: "or",
      left: {
        type: "comparison",
        operator: "==",
        left: { type: "member", path: ["a"] },
        right: { type: "literal", value: 1 },
      },
      right: {
        type: "logical",
        operator: "and",
        left: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["b"] },
          right: { type: "literal", value: 2 },
        },
        right: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["c"] },
          right: { type: "literal", value: 3 },
        },
      },
    });
  });

  test("`not` binds tighter than `and`, chains right-associatively", () => {
    expect(parse("not a == 1 and b == 2")).toEqual({
      type: "logical",
      operator: "and",
      left: {
        type: "unary",
        operator: "not",
        expression: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["a"] },
          right: { type: "literal", value: 1 },
        },
      },
      right: {
        type: "comparison",
        operator: "==",
        left: { type: "member", path: ["b"] },
        right: { type: "literal", value: 2 },
      },
    });
    expect(parse("not not a == 1")).toEqual({
      type: "unary",
      operator: "not",
      expression: {
        type: "unary",
        operator: "not",
        expression: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["a"] },
          right: { type: "literal", value: 1 },
        },
      },
    });
  });

  test("`and`/`or` chains are right-associative", () => {
    expect(parse("a == 1 and b == 2 and c == 3").type).toBe("logical");
    const tree = parse("a == 1 and b == 2 and c == 3");
    expect(tree).toEqual({
      type: "logical",
      operator: "and",
      left: {
        type: "comparison",
        operator: "==",
        left: { type: "member", path: ["a"] },
        right: { type: "literal", value: 1 },
      },
      right: {
        type: "logical",
        operator: "and",
        left: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["b"] },
          right: { type: "literal", value: 2 },
        },
        right: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["c"] },
          right: { type: "literal", value: 3 },
        },
      },
    });
  });

  test("parentheses override precedence", () => {
    expect(parse("(a == 1 or b == 2) and c == 3")).toEqual({
      type: "logical",
      operator: "and",
      left: {
        type: "logical",
        operator: "or",
        left: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["a"] },
          right: { type: "literal", value: 1 },
        },
        right: {
          type: "comparison",
          operator: "==",
          left: { type: "member", path: ["b"] },
          right: { type: "literal", value: 2 },
        },
      },
      right: {
        type: "comparison",
        operator: "==",
        left: { type: "member", path: ["c"] },
        right: { type: "literal", value: 3 },
      },
    });
  });

  test("multiline rule conditions parse", () => {
    const source = [
      'notification.reason == "mention"',
      "and (",
      '  notification.title contains "security"',
      '  or author.type == "Bot"',
      ")",
    ].join("\n");
    const tree = parse(source);
    expect(tree.type).toBe("logical");
    if (tree.type === "logical") {
      expect(tree.operator).toBe("and");
      expect(tree.right.type).toBe("logical");
    }
  });

  test("bare members and literals parse (validator decides their fate)", () => {
    expect(parse("notification.unread")).toEqual({
      type: "member",
      path: ["notification", "unread"],
    });
    expect(parse("true")).toEqual({ type: "literal", value: true });
  });

  test("syntax errors throw ParseError", () => {
    expect(() => parse("")).toThrow(ParseError);
    expect(() => parse("   ")).toThrow(ParseError);
    expect(() => parse("== 1")).toThrow(ParseError);
    expect(() => parse("a ==")).toThrow(ParseError);
    expect(() => parse("a == 1 == 2")).toThrow(ParseError);
    expect(() => parse("a b")).toThrow(ParseError);
    expect(() => parse("(a == 1")).toThrow(ParseError);
    expect(() => parse("a == 1)")).toThrow(ParseError);
    expect(() => parse("()")).toThrow(ParseError);
    expect(() => parse("a == 1 and")).toThrow(ParseError);
    expect(() => parse("not")).toThrow(ParseError);
  });

  test("`in` is not an operator, so `a in b` does not parse", () => {
    expect(() => parse("a in b")).toThrow(ParseError);
  });

  test("reserved words cannot be field names", () => {
    expect(() => parse("a.contains == 1")).toThrow(ParseError);
    expect(() => parse("a.and == 1")).toThrow(ParseError);
  });

  test("parse errors carry a position", () => {
    try {
      parse("a == ");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      // SAFETY: the preceding assertion establishes the tagged parse error type.
      expect((error as ParseError).position).toBe(5);
    }
  });
});
