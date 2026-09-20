import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import type { Expression } from "../../src/dsl/ast.ts";
import { ParseError } from "../../src/dsl/errors.ts";
import { compileExpression } from "../../src/dsl/evaluator.ts";
import { parse as parseEffect } from "../../src/dsl/parser.ts";
import { validate as validateEffect } from "../../src/dsl/validator.ts";
import { makeMentionEnv } from "./helpers.ts";

const parse = (source: string) => Effect.runSync(parseEffect(source));
const compileQuery = (source: string) => {
  const expression = Effect.runSync(parseEffect(source));
  Effect.runSync(validateEffect(expression));

  return { expression, matches: compileExpression(expression) };
};

describe("large DSL queries", () => {
  test("preserves every node in a 1,200-condition AND chain", () => {
    const conditionCount = 1_200;
    const source = Array.from({ length: conditionCount }, () => "notification.unread").join(
      " and\n",
    );

    const query = compileQuery(source);
    const counts = countNodes(query.expression);

    expect(counts.members).toBe(conditionCount);
    expect(counts.logical).toBe(conditionCount - 1);
    expect(counts.unary).toBe(0);
    expect(counts.comparisons).toBe(0);
    expect(Effect.runSync(query.matches(makeMentionEnv()))).toBe(true);
  });

  test("evaluates a false condition at the end of a 1,200-condition chain", () => {
    const source = [
      ...Array.from({ length: 1_199 }, () => "notification.unread"),
      "repo.private",
    ].join(" and ");

    const query = compileQuery(source);

    expect(Effect.runSync(query.matches(makeMentionEnv()))).toBe(false);
  });

  test("keeps AND precedence across 400 OR branches", () => {
    const branchCount = 400;
    const matchingBranch = 173;
    const source = Array.from(
      { length: branchCount },
      (_, index) => `notification.reason == "case-${index}" and repo.stars >= ${index}`,
    ).join(" or\n");
    const environment = makeMentionEnv();
    environment.notification.reason = `case-${matchingBranch}`;
    environment.repo.stars = matchingBranch;

    const query = compileQuery(source);
    const counts = countNodes(query.expression);

    // Correct parsing is (reason == case-0 AND stars >= 0) OR (...), etc.
    // If AND and OR had equal precedence, the later false star checks would
    // turn the matching branch false.
    expect(Effect.runSync(query.matches(environment))).toBe(true);
    expect(counts.comparisons).toBe(branchCount * 2);
    expect(counts.logical).toBe(branchCount * 2 - 1);
  });

  test("handles 300 nested parentheses and right-associative NOT operators", () => {
    const depth = 300;
    const evenSource = `${"not (".repeat(depth)}notification.unread${")".repeat(depth)}`;
    const oddSource = `not (${evenSource})`;

    const evenQuery = compileQuery(evenSource);
    const oddQuery = compileQuery(oddSource);

    expect(countNodes(evenQuery.expression).unary).toBe(depth);
    expect(Effect.runSync(evenQuery.matches(makeMentionEnv()))).toBe(true);
    expect(Effect.runSync(oddQuery.matches(makeMentionEnv()))).toBe(false);
  });

  test("parses a large realistic multiline GitHub filter", () => {
    const owners = Array.from({ length: 150 }, (_, index) => `owner-${index}`);
    owners[93] = "lucasnorgard";
    const reasons = Array.from({ length: 150 }, (_, index) => `reason-${index}`);
    reasons[71] = "mention";

    const ownerGroup = owners.map((owner) => `repo.owner == "${owner}"`).join("\n    or ");
    const reasonGroup = reasons
      .map((reason) => `notification.reason == "${reason}"`)
      .join("\n    or ");
    const source = `
      notification.unread
      and not repo.private
      and (
        ${ownerGroup}
      )
      and (
        ${reasonGroup}
      )
      and (
        notification.title contains "Security"
        or author.type == "Bot"
        or notification.type == "PullRequest"
      )
      and notification.updatedAt >= "2026-09-01T00:00:00.000Z"
    `;

    const query = compileQuery(source);
    const counts = countNodes(query.expression);

    expect(Effect.runSync(query.matches(makeMentionEnv()))).toBe(true);
    expect(counts.comparisons).toBe(304);
    expect(counts.members).toBe(306);
  });

  test("reports the exact end position after 1,000 valid clauses", () => {
    const source = `${Array.from({ length: 1_000 }, () => 'notification.reason == "mention"').join(
      " or ",
    )} and`;

    try {
      parse(source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      if (!(error instanceof ParseError)) {
        throw error;
      }
      expect(error.position).toBe(source.length);
    }
  });
});

interface NodeCounts {
  logical: number;
  comparisons: number;
  unary: number;
  members: number;
  literals: number;
}

function countNodes(expression: Expression): NodeCounts {
  const counts: NodeCounts = {
    logical: 0,
    comparisons: 0,
    unary: 0,
    members: 0,
    literals: 0,
  };
  const pending: Expression[] = [expression];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    switch (current.type) {
      case "logical":
        counts.logical++;
        pending.push(current.left, current.right);
        break;
      case "comparison":
        counts.comparisons++;
        pending.push(current.left, current.right);
        break;
      case "unary":
        counts.unary++;
        pending.push(current.expression);
        break;
      case "member":
        counts.members++;
        break;
      case "literal":
        counts.literals++;
        break;
    }
  }

  return counts;
}
