#!/usr/bin/env node
/**
 * Dependency-audit gate.
 *
 * The previous CI step was `npm audit --json > audit.json || true` followed by an inline
 * script that filtered a documented allowlist. Two problems, both of the "a gate that
 * cannot fail" kind:
 *
 * 1. `a.vulnerabilities || {}` meant a payload without the expected shape — an npm
 *    upgrade, a degraded registry response, a redirect that returned HTML-as-JSON —
 *    produced an empty set, and an empty set contains no unknown packages. It printed
 *    "only advisories the README documents are present" and exited 0 while having read
 *    nothing. Mutation-proven: feeding `{}` passed.
 * 2. The allowlist matched by package name only, so `@metamask/`, `@wagmi/`, `next`,
 *    `viem` and `ws` were excused at *any* severity. A critical that compromised a
 *    signing key would have been reported as "documented".
 *
 * So: reconcile the payload against npm's own summary before trusting that it exists,
 * and give every documented entry a severity ceiling. The names stay hand-maintained on
 * purpose, matching the README's "Known limits" — adding one should remain an edit a
 * reviewer can read, not a wildcard.
 */

import { readFileSync } from "node:fs";

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4, unknown: 4 };

/**
 * Documented, unavoidable, and capped.
 *
 * The ceiling is the highest severity we have accepted for this entry. npm reporting a
 * worse one is a new fact about the dependency, not the same known advisory, and it must
 * stop the build.
 */
const FAMILIES = [
  // The wallet stack: RainbowKit 2.2.11 pins wagmi ^2.9 and pulls these in. Patching
  // means dropping RainbowKit for wagmi 3 — a product decision, not a dependency bump.
  { prefix: "@walletconnect/", ceiling: "moderate" },
  { prefix: "@metamask/", ceiling: "moderate" },
  { prefix: "@reown/", ceiling: "moderate" },
  { prefix: "@rainbow-me/", ceiling: "moderate" },
  { prefix: "@wagmi/", ceiling: "moderate" },
  { prefix: "@base-org/", ceiling: "moderate" },
  { prefix: "@gemini-wallet/", ceiling: "moderate" },
];

const EXACT = [
  // Every released Next version through 16.3.0-preview depends on the affected postcss;
  // the advisory is unfixable from here. `ws` arrives through the wallet stack.
  { name: "postcss", ceiling: "high" },
  { name: "ws", ceiling: "high" },
  { name: "next", ceiling: "moderate" },
  { name: "viem", ceiling: "moderate" },
  { name: "wagmi", ceiling: "moderate" },
  { name: "decode-uri-component", ceiling: "moderate" },
  { name: "query-string", ceiling: "moderate" },
  { name: "uuid", ceiling: "moderate" },
];

function ceilingFor(name) {
  const exact = EXACT.find((e) => e.name === name);
  if (exact) return exact.ceiling;
  const family = FAMILIES.find((f) => name.startsWith(f.prefix));
  if (family) return family.ceiling;
  return null;
}

function main() {
  const path = process.argv[2] ?? "audit.json";

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${path} — npm audit wrote nothing, so nothing was checked.`);
    return;
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    fail(
      `${path} is not valid JSON (${err.message}). npm audit likely emitted a transport ` +
        `error rather than a report. Not a pass.`,
    );
    return;
  }

  // Prove we are holding an audit report before concluding anything from its contents.
  if (!report || typeof report !== "object") {
    fail(`${path} parsed to a non-object. Not a pass.`);
    return;
  }
  if (typeof report.auditReportVersion !== "number") {
    fail(
      `${path} has no auditReportVersion — this is not an ` +
        "`npm audit --json` payload of a shape we understand. Re-read the npm version " +
        "before trusting an empty result. Not a pass.",
    );
    return;
  }
  const vulns = report.vulnerabilities;
  if (!vulns || typeof vulns !== "object") {
    fail("`vulnerabilities` is absent from a payload that claims an auditReportVersion.");
    return;
  }
  const meta = report.metadata?.vulnerabilities;
  if (!meta || typeof meta.total !== "number") {
    fail("`metadata.vulnerabilities.total` is absent, so the report cannot be reconciled.");
    return;
  }
  const names = Object.keys(vulns);
  if (names.length !== meta.total) {
    fail(
      `the report is internally inconsistent: ${names.length} package entries but npm's ` +
        `own summary counts ${meta.total}. The schema changed underneath this gate; do not ` +
        `treat the difference as "no new advisories".`,
    );
    return;
  }

  const violations = [];
  for (const [name, info] of Object.entries(vulns)) {
    const severity = String(info?.severity ?? "unknown");
    const ceiling = ceilingFor(name);
    if (!ceiling) {
      violations.push(`${name}@${severity} is outside the documented set`);
      continue;
    }
    // Never excused, even by a documented name: a critical is a new fact.
    if (severity === "critical") {
      violations.push(
        `${name}@critical is not excused by the allowlist — the ceiling for ` +
          `${ceiling} does not cover a critical`,
      );
      continue;
    }
    if (RANK[severity] > RANK[ceiling]) {
      violations.push(
        `${name}@${severity} exceeds its documented ceiling of ${ceiling}`,
      );
    }
  }

  console.log(
    `audit gate: ${names.length} vulnerable package(s) examined, reconciled against ` +
      `npm's summary of ${meta.total} (info ${meta.info}, low ${meta.low}, ` +
      `moderate ${meta.moderate}, high ${meta.high}, critical ${meta.critical}).`,
  );

  if (violations.length) {
    console.error("dependency audit FAILED:");
    for (const v of violations) console.error(`  x ${v}`);
    console.error(
      "either fix the dependency, or add it to scripts/audit-gate.mjs with a ceiling and a " +
        "sentence in the README's Known limits — the list is hand-maintained on purpose.",
    );
    process.exit(1);
  }
  console.log("every advisory is inside the documented set and below its ceiling.");
}

function fail(message) {
  console.error(`dependency audit FAILED: ${message}`);
  process.exit(1);
}

main();
