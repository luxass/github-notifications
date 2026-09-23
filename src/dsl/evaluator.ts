import { Effect, Match, Predicate } from "effect";

import type { Expression } from "./ast.ts";
import type { QueryEnvironment, QueryValue } from "./environment.ts";
import { EvaluationError } from "./errors.ts";
import { fieldDefinitions } from "./schema.ts";

export type QueryPredicate = (
  environment: QueryEnvironment,
) => Effect.Effect<boolean, EvaluationError>;

export type PartialQueryResult = boolean | "unknown";

export type PartialQueryPredicate = (
  environment: QueryEnvironment,
) => Effect.Effect<PartialQueryResult, EvaluationError>;

export type ValueReader = (
  environment: QueryEnvironment,
) => Effect.Effect<QueryValue, EvaluationError>;

type ExpressionEvaluator = (
  environment: QueryEnvironment,
  subjectAvailable: boolean,
) => Effect.Effect<PartialQueryResult, EvaluationError>;

export const compileExpressionVariants = (expression: Expression) => {
  const evaluate = compileExpressionInternal(expression);

  const predicate: QueryPredicate = (environment) =>
    Effect.flatMap(evaluate(environment, true), (result) =>
      result === "unknown"
        ? Effect.fail(new EvaluationError({ message: "Unexpected unresolved subject field" }))
        : Effect.succeed(result),
    );

  const partialPredicate: PartialQueryPredicate = (environment) => evaluate(environment, false);

  return { predicate, partialPredicate };
};

export const compileExpression = (expression: Expression): QueryPredicate =>
  compileExpressionVariants(expression).predicate;

export const compilePartialExpression = (expression: Expression): PartialQueryPredicate =>
  compileExpressionVariants(expression).partialPredicate;

const compileExpressionInternal = (expression: Expression): ExpressionEvaluator => {
  switch (expression.type) {
    case "logical": {
      const left = compileExpressionInternal(expression.left);
      const right = compileExpressionInternal(expression.right);

      return (environment, subjectAvailable) =>
        Effect.gen(function* () {
          const leftResult = yield* left(environment, subjectAvailable);

          if (expression.operator === "and") {
            if (leftResult === false) {
              return false;
            }

            const rightResult = yield* right(environment, subjectAvailable);

            if (rightResult === false) {
              return false;
            }

            return leftResult === true && rightResult === true ? true : "unknown";
          }

          if (leftResult === true) {
            return true;
          }

          const rightResult = yield* right(environment, subjectAvailable);

          if (rightResult === true) {
            return true;
          }

          return leftResult === false && rightResult === false ? false : "unknown";
        });
    }

    case "unary": {
      const inner = compileExpressionInternal(expression.expression);

      return (environment, subjectAvailable) =>
        Effect.map(inner(environment, subjectAvailable), (result) =>
          result === "unknown" ? "unknown" : !result,
        );
    }

    case "comparison": {
      const predicate = compileComparison(expression);
      const usesSubject = expressionUsesSubject(expression);

      return (environment, subjectAvailable) =>
        !subjectAvailable && usesSubject
          ? Effect.succeed("unknown")
          : Effect.map(predicate(environment), (result) => result);
    }

    case "member": {
      const predicate = compileBooleanMember(expression);
      const usesSubject = expressionUsesSubject(expression);

      return (environment, subjectAvailable) =>
        !subjectAvailable && usesSubject
          ? Effect.succeed("unknown")
          : Effect.map(predicate(environment), (result) => result);
    }

    case "literal":
      return () =>
        Effect.fail(
          new EvaluationError({ message: "A literal cannot be evaluated directly as a condition" }),
        );

    default: {
      const exhaustive: never = expression;

      return exhaustive;
    }
  }
};

const expressionUsesSubject = (expression: Expression): boolean => {
  switch (expression.type) {
    case "logical":
      return expressionUsesSubject(expression.left) || expressionUsesSubject(expression.right);
    case "comparison":
      return expressionUsesSubject(expression.left) || expressionUsesSubject(expression.right);
    case "unary":
      return expressionUsesSubject(expression.expression);
    case "member":
      return expression.path[0] === "subject" || expression.path[0] === "author";
    case "literal":
      return false;
    default: {
      const exhaustive: never = expression;

      return exhaustive;
    }
  }
};

const compileComparison = (
  comparison: Extract<Expression, { readonly type: "comparison" }>,
): QueryPredicate => {
  const left = compileValue(comparison.left);
  const right = compileValue(comparison.right);

  if (comparison.operator === "==") {
    return (environment) =>
      Effect.map(Effect.zip(left(environment), right(environment)), ([leftValue, rightValue]) =>
        valuesEqual(leftValue, rightValue),
      );
  }

  if (comparison.operator === "!=") {
    return (environment) =>
      Effect.map(
        Effect.zip(left(environment), right(environment)),
        ([leftValue, rightValue]) => !valuesEqual(leftValue, rightValue),
      );
  }

  if (comparison.operator === "contains") {
    return (environment) =>
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

  return (environment) =>
    Effect.gen(function* () {
      const ordering = yield* compareValues(yield* left(environment), yield* right(environment));

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
};

const compileBooleanMember = (
  member: Extract<Expression, { readonly type: "member" }>,
): QueryPredicate => {
  const key = member.path.join(".");
  const entry = fieldDefinitions[key];

  if (entry === undefined || entry.type !== "boolean") {
    return () => Effect.fail(new EvaluationError({ message: `${key} is not a boolean field` }));
  }

  const read = entry.read;

  return (environment) =>
    Effect.gen(function* () {
      const value = read(environment);

      if (Predicate.isBoolean(value)) {
        return value;
      }

      return yield* Effect.fail(new EvaluationError({ message: `${key} is not a boolean field` }));
    });
};

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
