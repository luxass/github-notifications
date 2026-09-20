import { Schema } from "effect";
import { Effect } from "effect";

import { ComparisonOperator, LiteralValue } from "./ast.ts";
import { TokenizeError } from "./errors.ts";

export const Token = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("identifier"),
    value: Schema.String,
    start: Schema.Number,
    end: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("literal"),
    value: LiteralValue,
    start: Schema.Number,
    end: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("operator"),
    value: ComparisonOperator,
    start: Schema.Number,
    end: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literals(["and", "or", "not", "dot", "leftParen", "rightParen", "eof"]),
    start: Schema.Number,
    end: Schema.Number,
  }),
]);

export type Token = Schema.Schema.Type<typeof Token>;

export const tokenize = (input: string) =>
  Effect.gen(function* () {
    const tokens: Array<Token> = [];
    let position = 0;

    while (position < input.length) {
      const character = input[position];

      if (character !== undefined && /\s/.test(character)) {
        position++;
        continue;
      }

      if (character === '"') {
        let cursor = position + 1;
        let value = "";
        let closed = false;

        while (cursor < input.length) {
          const inner = input[cursor];

          if (inner === undefined) {
            break;
          }

          if (inner === '"') {
            closed = true;
            cursor++;
            break;
          }

          if (inner === "\\") {
            const next = input[cursor + 1];

            if (next === undefined) {
              return yield* Effect.fail(
                new TokenizeError({ message: "Unterminated escape sequence", position: cursor }),
              );
            }

            if (next === '"') {
              value += '"';
            } else if (next === "\\") {
              value += "\\";
            } else if (next === "n") {
              value += "\n";
            } else if (next === "r") {
              value += "\r";
            } else if (next === "t") {
              value += "\t";
            } else {
              return yield* Effect.fail(
                new TokenizeError({
                  message: `Unknown escape sequence "\\${next}"`,
                  position: cursor,
                }),
              );
            }

            cursor += 2;
            continue;
          }

          value += inner;
          cursor++;
        }

        if (!closed) {
          return yield* Effect.fail(
            new TokenizeError({ message: "Unterminated string", position }),
          );
        }

        tokens.push({ type: "literal", value, start: position, end: cursor });
        position = cursor;
        continue;
      }

      if (character !== undefined && character >= "0" && character <= "9") {
        let cursor = position;

        while (cursor < input.length) {
          const digit = input[cursor];

          if (digit === undefined || digit < "0" || digit > "9") {
            break;
          }

          cursor++;
        }

        const dot = input[cursor];
        const afterDot = input[cursor + 1];

        if (dot === "." && afterDot !== undefined && afterDot >= "0" && afterDot <= "9") {
          cursor++;

          while (cursor < input.length) {
            const fraction = input[cursor];

            if (fraction === undefined || fraction < "0" || fraction > "9") {
              break;
            }

            cursor++;
          }
        }

        tokens.push({
          type: "literal",
          value: Number(input.slice(position, cursor)),
          start: position,
          end: cursor,
        });
        position = cursor;
        continue;
      }

      const isIdentifierStart =
        character !== undefined &&
        ((character >= "a" && character <= "z") ||
          (character >= "A" && character <= "Z") ||
          character === "_");

      if (isIdentifierStart) {
        let cursor = position + 1;

        while (cursor < input.length) {
          const c = input[cursor];

          if (c === undefined) {
            break;
          }

          const isStart = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
          const isDigit = c >= "0" && c <= "9";

          if (!isStart && !isDigit) {
            break;
          }

          cursor++;
        }

        const value = input.slice(position, cursor);

        if (value === "and" || value === "or" || value === "not") {
          tokens.push({ type: value, start: position, end: cursor });
        } else if (value === "contains") {
          tokens.push({ type: "operator", value, start: position, end: cursor });
        } else if (value === "true") {
          tokens.push({ type: "literal", value: true, start: position, end: cursor });
        } else if (value === "false") {
          tokens.push({ type: "literal", value: false, start: position, end: cursor });
        } else if (value === "null") {
          tokens.push({ type: "literal", value: null, start: position, end: cursor });
        } else {
          tokens.push({ type: "identifier", value, start: position, end: cursor });
        }

        position = cursor;
        continue;
      }

      const two = input.slice(position, position + 2);

      if (two === "==" || two === "!=" || two === ">=" || two === "<=") {
        tokens.push({ type: "operator", value: two, start: position, end: position + 2 });
        position += 2;
        continue;
      }

      if (character === ">" || character === "<") {
        tokens.push({
          type: "operator",
          value: character,
          start: position,
          end: position + 1,
        });
        position++;
        continue;
      }

      if (character === ".") {
        tokens.push({ type: "dot", start: position, end: position + 1 });
        position++;
        continue;
      }

      if (character === "(") {
        tokens.push({ type: "leftParen", start: position, end: position + 1 });
        position++;
        continue;
      }

      if (character === ")") {
        tokens.push({ type: "rightParen", start: position, end: position + 1 });
        position++;
        continue;
      }

      return yield* Effect.fail(
        new TokenizeError({
          message: `Unexpected character "${character}"`,
          position,
        }),
      );
    }

    tokens.push({ type: "eof", start: position, end: position });

    return tokens;
  });
