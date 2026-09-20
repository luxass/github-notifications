import { Effect, Match, Predicate } from "effect";

import type { Expression } from "./ast.ts";
import { ValidationError } from "./errors.ts";
import { fieldDefinitions } from "./schema.ts";

export const validate = (expression: Expression): Effect.Effect<void, ValidationError> =>
  Match.value(expression).pipe(
    Match.when({ type: "logical" }, (logical) =>
      Effect.gen(function* () {
        yield* validate(logical.left);
        yield* validate(logical.right);
      }),
    ),
    Match.when({ type: "unary" }, (unary) => validate(unary.expression)),
    Match.when({ type: "comparison" }, (comparison) =>
      Effect.gen(function* () {
        if (comparison.left.type !== "member") {
          return yield* Effect.fail(
            new ValidationError({ message: "Left side of comparison must be a field" }),
          );
        }

        if (comparison.right.type !== "member" && comparison.right.type !== "literal") {
          return yield* Effect.fail(
            new ValidationError({
              message: "Right side of comparison must be a field or literal",
            }),
          );
        }

        const leftPath = comparison.left.path.join(".");
        const leftEntry = fieldDefinitions[leftPath];

        if (leftEntry === undefined) {
          return yield* Effect.fail(new ValidationError({ message: `Unknown field ${leftPath}` }));
        }

        const rightType =
          comparison.right.type === "member"
            ? (() => {
                const path = comparison.right.path.join(".");
                const entry = fieldDefinitions[path];

                if (entry === undefined) {
                  return null;
                }

                return entry.type;
              })()
            : Predicate.isString(comparison.right.value)
              ? "string"
              : Predicate.isNumber(comparison.right.value)
                ? "number"
                : Predicate.isBoolean(comparison.right.value)
                  ? "boolean"
                  : comparison.right.value === null
                    ? "null"
                    : null;

        if (rightType === null) {
          const path =
            comparison.right.type === "member" ? comparison.right.path.join(".") : "literal";

          return yield* Effect.fail(new ValidationError({ message: `Unknown field ${path}` }));
        }

        if (comparison.operator === "contains") {
          if (leftEntry.type === "string" && rightType === "string") {
            return yield* Effect.void;
          }

          return yield* Effect.fail(
            new ValidationError({ message: "Operator contains requires string operands" }),
          );
        }

        if (comparison.operator === "==" || comparison.operator === "!=") {
          if (rightType === "null" || leftEntry.type === rightType) {
            return yield* Effect.void;
          }

          if (leftEntry.type === "date" && rightType === "string") {
            if (
              comparison.right.type !== "literal" ||
              !Predicate.isString(comparison.right.value)
            ) {
              return yield* Effect.fail(
                new ValidationError({
                  message: "Date fields must be compared with a date field or ISO date string",
                }),
              );
            }

            if (Number.isNaN(Date.parse(comparison.right.value))) {
              return yield* Effect.fail(
                new ValidationError({
                  message: `Invalid date literal ${JSON.stringify(comparison.right.value)}`,
                }),
              );
            }

            return yield* Effect.void;
          }

          return yield* Effect.fail(
            new ValidationError({
              message: `Cannot compare ${leftEntry.type} with ${rightType}`,
            }),
          );
        }

        if (leftEntry.type !== "number" && leftEntry.type !== "date") {
          return yield* Effect.fail(
            new ValidationError({
              message: `Operator ${comparison.operator} cannot be used with ${leftEntry.type}`,
            }),
          );
        }

        if (leftEntry.type === "number" && rightType === "number") {
          return yield* Effect.void;
        }

        if (leftEntry.type === "date" && rightType === "date") {
          return yield* Effect.void;
        }

        if (leftEntry.type === "date" && rightType === "string") {
          if (comparison.right.type !== "literal" || !Predicate.isString(comparison.right.value)) {
            return yield* Effect.fail(
              new ValidationError({
                message: "Date fields must be compared with a date field or ISO date string",
              }),
            );
          }

          if (Number.isNaN(Date.parse(comparison.right.value))) {
            return yield* Effect.fail(
              new ValidationError({
                message: `Invalid date literal ${JSON.stringify(comparison.right.value)}`,
              }),
            );
          }

          return yield* Effect.void;
        }

        return yield* Effect.fail(
          new ValidationError({
            message: `Operator ${comparison.operator} cannot compare ${leftEntry.type} with ${rightType}`,
          }),
        );
      }),
    ),
    Match.when({ type: "member" }, (member) => {
      const path = member.path.join(".");
      const entry = fieldDefinitions[path];

      if (entry === undefined) {
        return Effect.fail(new ValidationError({ message: `Unknown field ${path}` }));
      }

      if (entry.type !== "boolean") {
        return Effect.fail(
          new ValidationError({
            message: `Bare field ${path} must be boolean, got ${entry.type}`,
          }),
        );
      }

      return Effect.void;
    }),
    Match.when({ type: "literal" }, () =>
      Effect.fail(
        new ValidationError({ message: "A literal cannot be used directly as a condition" }),
      ),
    ),
    Match.exhaustive,
  );
