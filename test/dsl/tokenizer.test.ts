import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { TokenizeError } from "../../src/dsl/errors.ts";
import { tokenize as tokenizeEffect } from "../../src/dsl/tokenizer.ts";

const tokenize = (source: string) => Effect.runSync(tokenizeEffect(source));

describe("tokenize", () => {
  test("empty and whitespace-only input produce just eof", () => {
    expect(tokenize("")).toEqual([{ type: "eof", start: 0, end: 0 }]);
    expect(tokenize("  \n\t ")).toEqual([{ type: "eof", start: 5, end: 5 }]);
  });

  test("member path with comparison", () => {
    expect(tokenize('notification.reason == "mention"')).toEqual([
      { type: "identifier", value: "notification", start: 0, end: 12 },
      { type: "dot", start: 12, end: 13 },
      { type: "identifier", value: "reason", start: 13, end: 19 },
      { type: "operator", value: "==", start: 20, end: 22 },
      { type: "literal", value: "mention", start: 23, end: 32 },
      { type: "eof", start: 32, end: 32 },
    ]);
  });

  test("number comparison", () => {
    expect(tokenize("repo.stars >= 10")).toEqual([
      { type: "identifier", value: "repo", start: 0, end: 4 },
      { type: "dot", start: 4, end: 5 },
      { type: "identifier", value: "stars", start: 5, end: 10 },
      { type: "operator", value: ">=", start: 11, end: 13 },
      { type: "literal", value: 10, start: 14, end: 16 },
      { type: "eof", start: 16, end: 16 },
    ]);
  });

  test("keywords and short expression", () => {
    expect(tokenize("a and b")).toEqual([
      { type: "identifier", value: "a", start: 0, end: 1 },
      { type: "and", start: 2, end: 5 },
      { type: "identifier", value: "b", start: 6, end: 7 },
      { type: "eof", start: 7, end: 7 },
    ]);
    expect(tokenize('not (x != 2) or y contains "z"').map((t) => t.type)).toEqual([
      "not",
      "leftParen",
      "identifier",
      "operator",
      "literal",
      "rightParen",
      "or",
      "identifier",
      "operator",
      "literal",
      "eof",
    ]);
  });

  test("keywords are case-sensitive and need word boundaries", () => {
    expect(tokenize("AND").map((t) => t.type)).toEqual(["identifier", "eof"]);
    expect(tokenize("notable")).toEqual([
      { type: "identifier", value: "notable", start: 0, end: 7 },
      { type: "eof", start: 7, end: 7 },
    ]);
    expect(tokenize("android or orange")).toEqual([
      { type: "identifier", value: "android", start: 0, end: 7 },
      { type: "or", start: 8, end: 10 },
      { type: "identifier", value: "orange", start: 11, end: 17 },
      { type: "eof", start: 17, end: 17 },
    ]);
  });

  test("`in` is a plain identifier, not an operator", () => {
    expect(tokenize("a in b")).toEqual([
      { type: "identifier", value: "a", start: 0, end: 1 },
      { type: "identifier", value: "in", start: 2, end: 4 },
      { type: "identifier", value: "b", start: 5, end: 6 },
      { type: "eof", start: 6, end: 6 },
    ]);
  });

  test("string escapes", () => {
    expect(tokenize('"a\\"b"')[0]).toEqual({ type: "literal", value: 'a"b', start: 0, end: 6 });
    expect(tokenize('"a\\\\b"')[0]).toEqual({ type: "literal", value: "a\\b", start: 0, end: 6 });
    expect(tokenize('"line\\nbreak"')[0]).toEqual({
      type: "literal",
      value: "line\nbreak",
      start: 0,
      end: 13,
    });
    expect(tokenize('"tab\\there"')[0]).toEqual({
      type: "literal",
      value: "tab\there",
      start: 0,
      end: 11,
    });
  });

  test("numbers: ints, floats, and trailing dot", () => {
    expect(tokenize("3.14")[0]).toEqual({ type: "literal", value: 3.14, start: 0, end: 4 });
    expect(tokenize("0")[0]).toEqual({ type: "literal", value: 0, start: 0, end: 1 });
    expect(tokenize("100.").map((t) => t.type)).toEqual(["literal", "dot", "eof"]);
  });

  test("booleans and null", () => {
    expect(tokenize("true")[0]).toEqual({ type: "literal", value: true, start: 0, end: 4 });
    expect(tokenize("false")[0]).toEqual({ type: "literal", value: false, start: 0, end: 5 });
    expect(tokenize("null")[0]).toEqual({ type: "literal", value: null, start: 0, end: 4 });
  });

  test("multiline input tokenizes (YAML block scalars)", () => {
    const source = 'notification.reason == "mention"\n  and repo.private == false';
    const types = tokenize(source).map((t) => t.type);
    expect(types).toEqual([
      "identifier",
      "dot",
      "identifier",
      "operator",
      "literal",
      "and",
      "identifier",
      "dot",
      "identifier",
      "operator",
      "literal",
      "eof",
    ]);
  });

  test("unexpected characters throw with position", () => {
    expect(() => tokenize("a = 1")).toThrow(TokenizeError);
    expect(() => tokenize("a = 1")).toThrow('Unexpected character "="');
    expect(() => tokenize("a ! b")).toThrow(TokenizeError);
    expect(() => tokenize("a & b")).toThrow(TokenizeError);
    expect(() => tokenize("'single'")).toThrow(TokenizeError);
  });

  test("unterminated strings and bad escapes throw", () => {
    expect(() => tokenize('"abc')).toThrow(TokenizeError);
    expect(() => tokenize('"ab\\')).toThrow(TokenizeError);
    expect(() => tokenize('"a\\qb"')).toThrow(TokenizeError);
  });
});
