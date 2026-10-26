// SPDX-License-Identifier: UNLICENSED
/**
 * Gate 752 — Probe materializer.
 *
 * Suite probes stop embedding content and start referencing
 * datasetId@version + split + derivation spec. The eval engine
 * materializes probes deterministically at run time from the
 * pinned dataset split. This is what makes train/holdout separation
 * enforceable: the agent sees train-split series, the verdict evaluates
 * against holdout points.
 */

import { sha256 } from "@crucible/crypto";
import type { CanonicalRow } from "./canonical.js";
import type { SplitRole, SplitEngine } from "./splits.js";

/** How a single dataset row is turned into probe content. */
export interface DerivationSpec {
  /** Which column is the probe input (what the agent sees). */
  inputColumn: string;
  /** Which column is the expected output (what the verdict checks against). */
  outputColumn?: string;
  /**
   * Template with {{column}} placeholders, or "raw" to emit the input column
   * as-is. Defaults to "{{inputColumn}}".
   */
  template?: string;
  /** Derivation kind: identity | symbolic | numeric | text. */
  kind: "identity" | "symbolic" | "numeric" | "text";
  /** Additional columns included as context alongside the input column. */
  contextColumns?: string[];
}

/** A probe that references a dataset split instead of embedding content. */
export interface ProbeSpec {
  /** Content-addressed dataset ID (= datasetId from registry). */
  datasetId: string;
  /** Dataset version (content hash of manifest at probe creation). */
  datasetVersion: string;
  /** Which split this probe is drawn from: train/dev/holdout. */
  split: SplitRole;
  /** How to derive content from a dataset row. */
  derivation: DerivationSpec;
  /** Which row keys to materialize. Empty = all rows of this split. */
  rowKeys?: string[];
}

/** Materialized probe content, ready for the eval engine. */
export interface MaterializedProbe {
  probeId: string;
  input: string;
  expectedOutput?: string;
  derivation: DerivationSpec;
  sourceRowId: string;
  split: SplitRole;
}

/** Content-addressed hash of a probe spec. Same spec = same hash. */
export function probeSpecHash(spec: ProbeSpec): string {
  return sha256(JSON.stringify(spec));
}

/**
 * Materialize a probe spec into concrete probe content from dataset rows.
 *
 * Deterministic: same spec + same rows + same split engine = same probes.
 * Only rows whose split role matches spec.split are materialized.
 *
 * @throws if a referenced rowKey is not in the split, or if the derivation
 *         references a column that doesn't exist in a row.
 */
export function materializeProbe(
  spec: ProbeSpec,
  rows: CanonicalRow[],
  splitEngine: SplitEngine,
): MaterializedProbe[] {
  const template = spec.derivation.template ?? "{{inputColumn}}";
  const probes: MaterializedProbe[] = [];

  console.log(
    "DEBUG materializeProbe: spec.rowKeys =",
    spec.rowKeys,
    "rows count:",
    rows.length,
  );

  for (const row of rows) {
    // Enforce split: only materialize rows whose split role matches.
    const role = splitEngine.roleFor(row.rowId);
    if (role !== spec.split) continue;
    // Honor explicit row key allowlist.
    if (spec.rowKeys?.length && !spec.rowKeys.includes(row.rowId)) continue;

    const inputValue = row.fields[spec.derivation.inputColumn];
    if (inputValue === undefined) {
      throw new Error(
        `probe derivation column "${spec.derivation.inputColumn}" not found in row ${row.rowId}`,
      );
    }

    const input = String(inputValue);
    let expectedOutput: string | undefined;
    if (spec.derivation.outputColumn) {
      const outputValue = row.fields[spec.derivation.outputColumn];
      if (outputValue === undefined) {
        throw new Error(
          `probe derivation output column "${spec.derivation.outputColumn}" not found in row ${row.rowId}`,
        );
      }
      expectedOutput = String(outputValue);
    }

    // Build context from contextColumns.
    let context = "";
    if (spec.derivation.contextColumns?.length) {
      const parts = spec.derivation.contextColumns
        .map((col) => {
          const v = row.fields[col];
          return v === undefined ? `${col}=<missing>` : `${col}=${String(v)}`;
        })
        .join(", ");
      context = ` [${parts}]`;
    }

    const rendered = template
      .replace(/\{\{inputColumn\}\}/g, input)
      .replace(/\{\{context\}\}/g, context);

    probes.push({
      probeId: `${spec.datasetId}:${spec.split}:${row.rowId}`,
      input: rendered,
      expectedOutput,
      derivation: spec.derivation,
      sourceRowId: row.rowId,
      split: spec.split,
    });
  }

  // Deterministic ordering: sort by source row ID.
  probes.sort((a, b) => a.sourceRowId.localeCompare(b.sourceRowId));
  return probes;
}

/**
 * Safe math expression evaluator for symbolic-distillation verdicts.
 *
 * Supports: + - * / ^ ( ) and numeric literals, plus the variable "x".
 * No function calls, no property access, no side effects — safe to evaluate
 * agent-submitted expressions without a full JS eval.
 *
 * Returns NaN if the expression cannot be parsed or evaluated.
 */
export function safeEval(expression: string, x: number): number {
  let tokens: Token[];
  try {
    tokens = tokenize(expression);
  } catch {
    return NaN;
  }
  if (tokens.length === 0) return NaN;
  let pos = 0;
  const result = parseExpression(tokens, pos, x);
  if (!result.ok || result.pos !== tokens.length) return NaN;
  return result.value;
}

interface Token {
  type: "number" | "x" | "plus" | "minus" | "star" | "slash" | "caret" | "lparen" | "rparen";
  value?: number;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (!ch) break;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "x") {
      tokens.push({ type: "x" });
      i++;
      continue;
    }
    if (ch === "+") {
      tokens.push({ type: "plus" });
      i++;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: "minus" });
      i++;
      continue;
    }
    if (ch === "*") {
      tokens.push({ type: "star" });
      i++;
      continue;
    }
    if (ch === "/") {
      tokens.push({ type: "slash" });
      i++;
      continue;
    }
    if (ch === "^") {
      tokens.push({ type: "caret" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    const numMatch = expression.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (numMatch) {
      tokens.push({ type: "number", value: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    throw new Error(`Unexpected character: ${ch}`);
  }
  return tokens;
}

interface ParseResult {
  ok: boolean;
  value: number;
  pos: number;
}

function parseExpression(
  tokens: Token[],
  pos: number,
  x: number,
): ParseResult {
  let result = parseTerm(tokens, pos, x);
  if (!result.ok) return result;
  while (result.pos < tokens.length) {
    const tok = tokens[result.pos];
    if (!tok) break;
    if (tok.type === "plus") {
      const rhs = parseTerm(tokens, result.pos + 1, x);
      if (!rhs.ok) return rhs;
      result.value += rhs.value;
      result.pos = rhs.pos;
    } else if (tok.type === "minus") {
      const rhs = parseTerm(tokens, result.pos + 1, x);
      if (!rhs.ok) return rhs;
      result.value -= rhs.value;
      result.pos = rhs.pos;
    } else {
      break;
    }
  }
  return result;
}

function parseTerm(
  tokens: Token[],
  pos: number,
  x: number,
): ParseResult {
  let result = parseFactor(tokens, pos, x);
  if (!result.ok) return result;
  while (result.pos < tokens.length) {
    const tok = tokens[result.pos];
    if (!tok) break;
    if (tok.type === "star") {
      const rhs = parseFactor(tokens, result.pos + 1, x);
      if (!rhs.ok) return rhs;
      result.value *= rhs.value;
      result.pos = rhs.pos;
    } else if (tok.type === "slash") {
      const rhs = parseFactor(tokens, result.pos + 1, x);
      if (!rhs.ok) return rhs;
      if (rhs.value === 0) return { ok: false, value: 0, pos: result.pos };
      result.value /= rhs.value;
      result.pos = rhs.pos;
    } else {
      break;
    }
  }
  return result;
}

function parseFactor(
  tokens: Token[],
  pos: number,
  x: number,
): ParseResult {
  const tok = tokens[pos];
  if (!tok) return { ok: false, value: 0, pos };
  let base: number;
  let nextPos: number;
  if (tok.type === "number") {
    base = tok.value!;
    nextPos = pos + 1;
  } else if (tok.type === "x") {
    base = x;
    nextPos = pos + 1;
  } else if (tok.type === "lparen") {
    const inner = parseExpression(tokens, pos + 1, x);
    if (!inner.ok) return inner;
    if (
      inner.pos >= tokens.length ||
      !tokens[inner.pos] ||
      tokens[inner.pos]!.type !== "rparen"
    ) {
      return { ok: false, value: 0, pos: inner.pos };
    }
    base = inner.value;
    nextPos = inner.pos + 1;
  } else if (tok.type === "minus") {
    // Unary minus
    const inner = parseFactor(tokens, pos + 1, x);
    if (!inner.ok) return inner;
    return { ok: true, value: -inner.value, pos: inner.pos };
  } else {
    return { ok: false, value: 0, pos };
  }

  // Right-associative exponentiation: a ^ b ^ c = a ^ (b ^ c)
  if (nextPos < tokens.length && tokens[nextPos]!.type === "caret") {
    const exponent = parseFactor(tokens, nextPos + 1, x);
    if (!exponent.ok) return exponent;
    return { ok: true, value: Math.pow(base, exponent.value), pos: exponent.pos };
  }

  return { ok: true, value: base, pos: nextPos };
}

/**
 * Evaluate a submitted symbolic expression against holdout probes.
 * Substitutes the input column value into the expression and compares
 * the result to the expected output. Returns mean squared error and
 * pass rate (within 1e-6 relative tolerance).
 *
 * This is the symbolic-distillation verdict path (G-744): the agent
 * submits an equation, we evaluate it against holdout points only —
 * train points are never used for grading.
 *
 * Uses safeEval (no eval()) so agent-submitted expressions cannot execute
 * arbitrary code.
 */
export function evaluateSymbolic(
  submittedExpression: string,
  holdoutProbes: MaterializedProbe[],
): { mse: number; maxError: number; passRate: number; total: number } {
  if (holdoutProbes.length === 0) {
    return { mse: 0, maxError: 0, passRate: 1, total: 0 };
  }

  let sumSquaredError = 0;
  let maxError = 0;
  let passes = 0;

  for (const probe of holdoutProbes) {
    const expected = Number(probe.expectedOutput);
    if (!Number.isFinite(expected)) continue;

    const x = probeInputValue(probe);
    let actual: number;
    try {
      actual = safeEval(submittedExpression, x);
      if (!Number.isFinite(actual)) throw new Error("non-finite result");
    } catch {
      actual = NaN;
    }

    const error = Math.abs(actual - expected);
    sumSquaredError += error * error;
    maxError = Math.max(maxError, error);
    const tolerance = 1e-6 * Math.max(1, Math.abs(expected));
    if (error <= tolerance) passes += 1;
  }

  const total = holdoutProbes.length;
  return {
    mse: sumSquaredError / total,
    maxError,
    passRate: passes / total,
    total,
  };
}

/** Extract the numeric input value from a probe for expression substitution. */
function probeInputValue(probe: MaterializedProbe): number {
  const match = probe.input.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}
