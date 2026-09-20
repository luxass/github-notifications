import { Effect } from "effect";

import type { Expression } from "./ast.ts";
import { ParseError, type TokenizeError } from "./errors.ts";
import { tokenize, type Token } from "./tokenizer.ts";

type Cursor = {
  readonly tokens: ReadonlyArray<Token>;
  readonly pos: number;
};

export const parse = (source: string): Effect.Effect<Expression, ParseError | TokenizeError> =>
  Effect.gen(function* () {
    const tokens = yield* tokenize(source);
    const [expression, rest] = yield* parseOr({ tokens, pos: 0 });
    const end = rest.tokens[rest.pos];

    if (end === undefined || end.type !== "eof") {
      return yield* Effect.fail(
        new ParseError({
          message: `Expected eof, got ${end?.type ?? "end of input"}`,
          position: end?.start ?? source.length,
        }),
      );
    }

    return expression;
  });

const peek = (cursor: Cursor): Effect.Effect<Token, ParseError> => {
  const token = cursor.tokens[cursor.pos];

  if (token === undefined) {
    return Effect.fail(new ParseError({ message: "Unexpected end of input", position: 0 }));
  }

  return Effect.succeed(token);
};

const parseMemberPath = (
  cursor: Cursor,
  path: ReadonlyArray<string>,
): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const dot = cursor.tokens[cursor.pos];

    if (dot === undefined || dot.type !== "dot") {
      return [{ type: "member", path }, cursor] as const;
    }

    const afterDot: Cursor = { tokens: cursor.tokens, pos: cursor.pos + 1 };
    const name = yield* peek(afterDot);

    if (name.type !== "identifier") {
      return yield* Effect.fail(
        new ParseError({
          message: `Expected identifier, got ${name.type}`,
          position: name.start,
        }),
      );
    }

    return yield* parseMemberPath({ tokens: cursor.tokens, pos: afterDot.pos + 1 }, [
      ...path,
      name.value,
    ]);
  });

const parseMember = (cursor: Cursor): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const first = yield* peek(cursor);

    if (first.type !== "identifier") {
      return yield* Effect.fail(
        new ParseError({
          message: `Expected identifier, got ${first.type}`,
          position: first.start,
        }),
      );
    }

    return yield* parseMemberPath({ tokens: cursor.tokens, pos: cursor.pos + 1 }, [first.value]);
  });

const parsePrimary = (cursor: Cursor): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const token = yield* peek(cursor);

    if (token.type === "leftParen") {
      const [expression, afterOpen] = yield* parseOr({
        tokens: cursor.tokens,
        pos: cursor.pos + 1,
      });

      const closing = yield* peek(afterOpen);

      if (closing.type !== "rightParen") {
        return yield* Effect.fail(
          new ParseError({
            message: `Expected rightParen, got ${closing.type}`,
            position: closing.start,
          }),
        );
      }

      return [expression, { tokens: cursor.tokens, pos: afterOpen.pos + 1 }] as const;
    }

    if (token.type === "literal") {
      return [
        { type: "literal", value: token.value },
        { tokens: cursor.tokens, pos: cursor.pos + 1 },
      ] as const;
    }

    return yield* parseMember(cursor);
  });

const parseComparison = (
  cursor: Cursor,
): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const [left, afterLeft] = yield* parsePrimary(cursor);
    const token = afterLeft.tokens[afterLeft.pos];

    if (token === undefined || token.type !== "operator") {
      return [left, afterLeft] as const;
    }

    const [right, afterRight] = yield* parsePrimary({
      tokens: cursor.tokens,
      pos: afterLeft.pos + 1,
    });

    return [{ type: "comparison", operator: token.value, left, right }, afterRight] as const;
  });

const parseNot = (cursor: Cursor): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const token = cursor.tokens[cursor.pos];

    if (token !== undefined && token.type === "not") {
      const [expression, rest] = yield* parseNot({ tokens: cursor.tokens, pos: cursor.pos + 1 });

      return [{ type: "unary", operator: "not", expression }, rest] as const;
    }

    return yield* parseComparison(cursor);
  });

const parseAnd = (cursor: Cursor): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const [left, afterLeft] = yield* parseNot(cursor);
    const token = afterLeft.tokens[afterLeft.pos];

    if (token === undefined || token.type !== "and") {
      return [left, afterLeft] as const;
    }

    const [right, afterRight] = yield* parseAnd({
      tokens: afterLeft.tokens,
      pos: afterLeft.pos + 1,
    });

    return [{ type: "logical", operator: "and", left, right }, afterRight] as const;
  });

const parseOr = (cursor: Cursor): Effect.Effect<readonly [Expression, Cursor], ParseError> =>
  Effect.gen(function* () {
    const [left, afterLeft] = yield* parseAnd(cursor);
    const token = afterLeft.tokens[afterLeft.pos];

    if (token === undefined || token.type !== "or") {
      return [left, afterLeft] as const;
    }

    const [right, afterRight] = yield* parseOr({
      tokens: afterLeft.tokens,
      pos: afterLeft.pos + 1,
    });

    return [{ type: "logical", operator: "or", left, right }, afterRight] as const;
  });
