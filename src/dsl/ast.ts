import { Schema } from "effect";

export const ComparisonOperator = Schema.Literals(["==", "!=", ">", ">=", "<", "<=", "contains"]);

export type ComparisonOperator = Schema.Schema.Type<typeof ComparisonOperator>;

export const LiteralValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);

export type LiteralValue = Schema.Schema.Type<typeof LiteralValue>;

export interface LogicalExpression {
  readonly type: "logical";
  readonly operator: "and" | "or";
  readonly left: Expression;
  readonly right: Expression;
}

export interface ComparisonExpression {
  readonly type: "comparison";
  readonly operator: ComparisonOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpression {
  readonly type: "unary";
  readonly operator: "not";
  readonly expression: Expression;
}

export interface MemberExpression {
  readonly type: "member";
  readonly path: ReadonlyArray<string>;
}

export interface LiteralExpression {
  readonly type: "literal";
  readonly value: LiteralValue;
}

export type Expression =
  | LogicalExpression
  | ComparisonExpression
  | UnaryExpression
  | MemberExpression
  | LiteralExpression;
