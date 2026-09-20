import { Effect, Match, Predicate } from "effect";

import type { Expression } from "./ast.ts";
import type { QueryEnvironment, QueryValue } from "./environment.ts";
import { EvaluationError } from "./errors.ts";
import { fieldDefinitions } from "./schema.ts";

export type QueryPredicate = (
  environment: QueryEnvironment,
) => Effect.Effect<boolean, EvaluationError>;

export type ValueReader = (
  environment: QueryEnvironment,
) => Effect.Effect<QueryValue, EvaluationError>;

export const compileExpression = (expression: Expression): QueryPredicate =>
  Match.value(expression).pipe(
    Match.when({ type: "logical" }, (logical) => {
      const left = compileExpression(logical.left);
      const right = compileExpression(logical.right);

      if (logical.operator === "and") {
        return (environment: QueryEnvironment) =>
          Effect.gen(function* () {
            if (!(yield* left(environment))) {
              return false;
            }

            return yield* right(environment);
          });
      }

      return (environment: QueryEnvironment) =>
        Effect.gen(function* () {
          if (yield* left(environment)) {
            return true;
          }

          return yield* right(environment);
        });
    }),
    Match.when({ type: "unary" }, (unary) => {
      const inner = compileExpression(unary.expression);

      return (environment: QueryEnvironment) => Effect.map(inner(environment), (value) => !value);
    }),
    Match.when({ type: "comparison" }, (comparison) => {
      const left = compileValue(comparison.left);
      const right = compileValue(comparison.right);

      if (comparison.operator === "==") {
        return (environment: QueryEnvironment) =>
          Effect.map(Effect.zip(left(environment), right(environment)), ([leftValue, rightValue]) =>
            valuesEqual(leftValue, rightValue),
          );
      }

      if (comparison.operator === "!=") {
        return (environment: QueryEnvironment) =>
          Effect.map(
            Effect.zip(left(environment), right(environment)),
            ([leftValue, rightValue]) => !valuesEqual(leftValue, rightValue),
          );
      }

      if (comparison.operator === "contains") {
        return (environment: QueryEnvironment) =>
          Effect.gen(function* () {
            const leftValue = yield* left(environment);
            const rightValue = yield* right(environment);

            if (Predicate.isString(leftValue) && Predicate.isString(rightValue)) {
              return leftValue.includes(rightValue);
            }

            return yield* Effect.fail(
              new EvaluationError({ message: "Operator contains requires string operands" }),
            );
          });
      }

      const operator = comparison.operator;

      return (environment: QueryEnvironment) =>
        Effect.gen(function* () {
          const ordering = yield* compareValues(
            yield* left(environment),
            yield* right(environment),
          );

          if (operator === ">") {
            return ordering > 0;
          }

          if (operator === ">=") {
            return ordering >= 0;
          }

          if (operator === "<") {
            return ordering < 0;
          }

          return ordering <= 0;
        });
    }),
    Match.when({ type: "member" }, (member) => {
      const key = member.path.join(".");
      const entry = fieldDefinitions[key];

      if (entry === undefined || entry.type !== "boolean") {
        return () => Effect.fail(new EvaluationError({ message: `${key} is not a boolean field` }));
      }

      const read = entry.read;

      return (environment: QueryEnvironment) =>
        Effect.gen(function* () {
          const value = read(environment);

          if (Predicate.isBoolean(value)) {
            return value;
          }

          return yield* Effect.fail(
            new EvaluationError({ message: `${key} is not a boolean field` }),
          );
        });
    }),
    Match.when(
      { type: "literal" },
      () => () =>
        Effect.fail(
          new EvaluationError({ message: "A literal cannot be evaluated directly as a condition" }),
        ),
    ),
    Match.exhaustive,
  );

export const compileValue = (expression: Expression): ValueReader =>
  Match.value(expression).pipe(
    Match.when({ type: "literal" }, (literal) => () => Effect.succeed(literal.value)),
    Match.when({ type: "member" }, (member) => {
      const key = member.path.join(".");
      const entry = fieldDefinitions[key];

      if (entry === undefined) {
        return () => Effect.fail(new EvaluationError({ message: `Cannot resolve field ${key}` }));
      }

      const read = entry.read;

      return (environment: QueryEnvironment) => Effect.succeed(read(environment));
    }),
    Match.orElse(
      () => () =>
        Effect.fail(
          new EvaluationError({
            message: `Cannot use ${expression.type} expression as a value`,
          }),
        ),
    ),
  );

export const evaluate = (
  expression: Expression,
  environment: QueryEnvironment,
): Effect.Effect<boolean, EvaluationError> => compileExpression(expression)(environment);

const valuesEqual = (left: QueryValue, right: QueryValue): boolean => {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (left instanceof Date && Predicate.isString(right)) {
    return left.getTime() === Date.parse(right);
  }

  if (right instanceof Date && Predicate.isString(left)) {
    return Date.parse(left) === right.getTime();
  }

  return left === right;
};

const compareValues = (
  left: QueryValue,
  right: QueryValue,
): Effect.Effect<number, EvaluationError> =>
  Effect.gen(function* () {
    const normalizedLeft = yield* normalizeComparable(left);
    const normalizedRight = yield* normalizeComparable(right);

    if (Predicate.isNumber(normalizedLeft) && Predicate.isNumber(normalizedRight)) {
      if (normalizedLeft < normalizedRight) {
        return -1;
      }

      if (normalizedLeft > normalizedRight) {
        return 1;
      }

      return 0;
    }

    if (Predicate.isString(normalizedLeft) && Predicate.isString(normalizedRight)) {
      if (normalizedLeft < normalizedRight) {
        return -1;
      }

      if (normalizedLeft > normalizedRight) {
        return 1;
      }

      return 0;
    }

    return yield* Effect.fail(
      new EvaluationError({ message: "Cannot compare incompatible values" }),
    );
  });

const normalizeComparable = (
  value: QueryValue,
): Effect.Effect<number | string, EvaluationError> => {
  if (value instanceof Date) {
    return Effect.succeed(value.getTime());
  }

  if (Predicate.isNumber(value)) {
    return Effect.succeed(value);
  }

  if (Predicate.isString(value)) {
    const timestamp = Date.parse(value);

    return Effect.succeed(Number.isNaN(timestamp) ? value : timestamp);
  }

  return Effect.fail(new EvaluationError({ message: `Value is not comparable: ${String(value)}` }));
};
