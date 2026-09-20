# GitHub Notifications DSL — implementation contract

You implement the source. The tests under `test/dsl/` verify it.
This file pins the exact contract the tests assert, so there are no surprises.

## Layout (you create these)

```
src/dsl/ast.ts          AST node types (shapes below)
src/dsl/tokenizer.ts    tokenize(input) -> tokens
src/dsl/parser.ts       parse(source) -> AST
src/dsl/schema.ts       locked GitHub-notifications field schema
src/dsl/validator.ts    validate(expression) -> void (throws)
src/dsl/evaluator.ts    evaluate(expression, environment) -> boolean
src/dsl/query.ts        compileQuery(source) -> { source, expression, matches }
src/dsl/rule-engine.ts  compileRules / executeRules
```

Implement in this order, running the matching test file after each step:

```sh
bun test test/dsl/tokenizer.test.ts
bun test test/dsl/parser.test.ts
bun test test/dsl/validator.test.ts
bun test test/dsl/evaluator.test.ts
bun test test/dsl/query.test.ts
bun test test/dsl/rule-engine.test.ts
bun test test/dsl   # everything once all layers exist
```

Before a layer exists its test file fails with "Cannot find module".
That is the expected red phase, not a broken setup.

## Exact API surface

```ts
// tokenizer.ts
export function tokenize(input: string): Token[];
export class TokenizeError extends Error {
  readonly position: number;
}

// parser.ts
export function parse(source: string): Expression;
export class ParseError extends Error {
  readonly position: number;
}

// validator.ts
export function validate(expression: Expression): void;
export class ValidationError extends Error {}

// evaluator.ts
export function evaluate(expression: Expression, environment: QueryEnvironment): boolean;
// QueryEnvironment shape is yours to define, but it must accept the fixture
// in test/dsl/helpers.ts (notification / repo / author / ctx, see schema).

// query.ts
export interface CompiledQuery {
  source: string;
  expression: Expression;
  matches(environment: QueryEnvironment): boolean;
}
export function compileQuery(source: string): CompiledQuery;
// compileQuery runs parse, then validate, then returns the query.
// Tokenize/parse/validation errors propagate with their original classes.

// rule-engine.ts
export function compileRules(definitions: RuleDefinition[]): CompiledRule[];
export function executeRules(
  rules: CompiledRule[],
  environment: QueryEnvironment,
  executor: ActionExecutor,
): Promise<string[]>;
// compileRules compiles each `when` and defaults `stop` to false.
// executeRules runs top to bottom, awaits each action in order,
// returns matched rule names, and stops after a rule with stop: true.
```

## Tokens (runtime shapes the tests assert)

```ts
{ type: "identifier", value: string, start: number, end: number }
{ type: "literal", value: string | number | boolean | null, start: number, end: number }
{ type: "operator", value: "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains", start: number, end: number }
{ type: "and" | "or" | "not" | "dot" | "leftParen" | "rightParen" | "eof", start: number, end: number }
```

Rules: `and` / `or` / `not` / `contains` are keywords (case-sensitive: `AND`
is an identifier). String escapes: `\" \\ \n \r \t`. Numbers: ints and
floats (`100.` is `100` followed by a dot). Whitespace includes newlines, so
multiline YAML `when: |` blocks tokenize directly.

## AST shapes

```ts
{ type: "logical", operator: "and" | "or", left: Expression, right: Expression }
{ type: "comparison", operator: ComparisonOperator, left: Expression, right: Expression }
{ type: "unary", operator: "not", expression: Expression }
{ type: "member", path: string[] }
{ type: "literal", value: string | number | boolean | null }
```

Precedence, lowest to highest: `or`, `and`, `not`, comparison, primary.
`and`/`or` chains are left-associative. `not` is right-associative.
A comparison takes exactly one operator (`a == 1 == 2` is a parse error).
Any trailing tokens after a full expression are a parse error, as is empty input.

## Locked schema (GitHub notifications, not mail)

| Path                   | Type    |
| ---------------------- | ------- |
| notification.reason    | string  |
| notification.unread    | boolean |
| notification.title     | string  |
| notification.type      | string  |
| notification.updatedAt | date    |
| repo.name              | string  |
| repo.owner             | string  |
| repo.fullName          | string  |
| repo.private           | boolean |
| repo.stars             | number  |
| author.login           | string  |
| author.type            | string  |
| ctx.login              | string  |

Operator matrix: `==` / `!=` on any type; `contains` on strings only;
`>` / `>=` / `<` / `<=` on numbers and dates only. The left side of a
comparison must be a field. Unknown roots/fields and namespace paths used
as values (`repo` alone) are validation errors.

## Deliberate deviations from the mail reference (~/downloads/crux-mail-dsl)

1. **`in` is dropped.** The reference tokenizes it but its evaluator throws
   "not implemented" (there are no list literals to put on the right side).
   Here `in` is a plain identifier and `a in b` is a parse error.
   Re-add it later together with list literals if you want it.
2. **Bare boolean fields are valid conditions.** `notification.unread` means
   `notification.unread == true`. Bare non-boolean fields
   (`notification.title`) and bare literals (`true`, `42`) are validation
   errors. The reference instead throws at evaluation time.
3. **Roots/fields/actions are GitHub-flavored** (table above). The suggested
   starting action set is `notify` / `markRead` / `mute` / `open` — adapt it,
   but then update the rule-engine tests to match.
4. **String comparison is case-sensitive and lexicographic**, dates compare
   against ISO strings (`notification.updatedAt > "2026-09-01T00:00:00.000Z"`).
   Mixed garbage (number vs non-date string) is unspecified — don't rely on it.
