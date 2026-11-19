/**
 * @file patch-policy.ts — what a candidate patch is allowed to touch.
 *
 * Blueprint §3.6: "Reject or flag a patch if it deletes/skips/weakens tests;
 * changes the harness or evaluator; ... modifies unrelated paths beyond policy".
 * `EngineeringTaskPackage` has carried `allowedPaths` and `forbiddenPaths` since
 * the first version of the adapter and **nothing read them** — a declared policy
 * that no code enforces is worse than no policy, because the task author believes
 * it is in force.
 *
 * This module is the reader. It is pure: a list of changed paths in, a list of
 * violations out. The runner calls it before `git apply` (a patch that would
 * touch an out-of-scope path never lands), and `validateEngineeringTask` calls it
 * on the policy itself (a task whose allowlist is `../..` is refused at
 * publication rather than at run time).
 *
 * ── the rules, and why each one ───────────────────────────────────────────────
 *
 *   - **Paths are normalised, not trusted.** `a/../../etc/passwd`, `C:\x`,
 *     `//server/share` and `src/./x` all name something other than what a
 *     reader sees. A path that cannot be normalised is a violation, not a
 *     skip: the safe answer to "I cannot tell what this touches" is "no".
 *   - **The evaluator and the harness are always off limits.** Not by default —
 *     *always*. A task that could allow its own grader to be edited has no
 *     grader.
 *   - **Tests are off limits unless the task says otherwise.** A regression
 *     repair that edits the failing test is not a repair (the baseline must
 *     reproduce, and the patch must not move the goalposts). `allowTestEdits`
 *     exists for the feature-with-acceptance-tests family, where the sponsor's
 *     own suite is the thing under development.
 *   - **An allowlist is a whitelist, not a hint.** When `allowedPaths` is
 *     present, anything outside it is a violation even if no forbidden pattern
 *     matches. When it is absent, only the forbidden rules apply — and the task
 *     validation says so as a warning, because "no allowlist" is a weaker task.
 *   - **A binary change is flagged.** A patch that flips bytes in an opaque file
 *     cannot be reviewed and is a classic way to smuggle a test fixture change.
 */

/** One file a patch touches, as the diff names it. */
export interface ChangedFile {
  path: string;
  change?: "added" | "modified" | "deleted" | "renamed";
  /** The pre-rename path, when the diff carries one. */
  previousPath?: string;
  /** True when the diff marks the content as binary. */
  binary?: boolean;
}

export interface PatchPolicy {
  /** Relative globs the patch may touch. Absent means "no allowlist". */
  allowedPaths?: readonly string[];
  /** Relative globs the patch may never touch, in addition to the built-in rules. */
  forbiddenPaths?: readonly string[];
  /**
   * Whether this task's patch may edit test files.
   *
   * Defaults to false. The feature-acceptance family sets it true because the
   * sponsor's suite is the deliverable; a regression-repair task must not.
   */
  allowTestEdits?: boolean;
}

export type PatchViolationCode =
  | "bad_path"
  | "outside_allowed"
  | "forbidden_path"
  | "test_edit"
  | "harness_edit"
  | "binary_change";

export interface PatchViolation {
  path: string;
  code: PatchViolationCode;
  detail: string;
}

export interface PatchPolicyResult {
  ok: boolean;
  violations: PatchViolation[];
  /** The normalised paths that were checked, for the evidence detail. */
  files: string[];
}

/**
 * Paths that are never editable by a candidate patch, whatever the task says.
 *
 * `evaluator/` and `harness/` are the grader and the thing that runs it;
 * `.git/` is the repository's own history. A task cannot opt out of these, and
 * the omission of an opt-out is the point.
 */
const ALWAYS_FORBIDDEN: readonly string[] = [
  "**/.git/**",
  "**/evaluator/**",
  "**/hidden-tests/**",
  "**/harness/**",
];

/** Paths that are test code, in the conventions this repository actually uses. */
const TEST_PATTERNS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*_test.go",
  "**/*_test.py",
  "**/test_*.py",
  "**/*.t.sol",
];

/**
 * Normalise a POSIX-style relative path.
 *
 * Returns `null` when the path is not one a patch may name. Backslashes are
 * refused rather than converted: a diff that spells `src\a.ts` is not a diff
 * `git apply` reads the same way on every host, so the answer is "cannot tell".
 */
export function normalisePatchPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\0")) return null;
  if (trimmed.includes("\\")) return null;
  if (trimmed.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(trimmed)) return null; // a drive letter is not relative
  if (trimmed.startsWith("~")) return null;
  // `/dev/null` is how a diff names a created or deleted file. It is a marker,
  // not a path, and the caller keeps it out of the check.
  if (trimmed === "/dev/null") return null;

  const segments = trimmed.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") return null;
    if (segment === "..") return null; // escaping the workspace is never in scope
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Segment-wise glob matching: `**` spans segments, `*` and `?` stay inside one.
 *
 * Written rather than imported because the matching rule is a security boundary
 * and a dependency's idea of `**` (does it match zero segments? a dotfile?) is
 * not something this file can leave to chance. Recursive on segments; the
 * memo avoids exponential backtracking on hostile patterns.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  const memo = new Map<string, boolean>();

  const walk = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (pi === p.length) {
      result = si === s.length;
    } else if (p[pi] === "**") {
      // Zero segments, or consume one and stay on `**`.
      result = walk(pi + 1, si) || (si < s.length && walk(pi, si + 1));
    } else if (si >= s.length) {
      result = false;
    } else {
      result = matchSegment(p[pi]!, s[si]!) && walk(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };

  return walk(0, 0);
}

function matchSegment(pattern: string, segment: string): boolean {
  // `*` and `?` inside a segment; everything else is literal. Escaping is not
  // supported on purpose: a task author who needs a literal `*` in a filename
  // has a filename no patch tool handles predictably either.
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(segment);
}

/** Does this path name test code? */
export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => matchGlob(pattern, path));
}

/** Does this path name the grader, the harness, or git's own history? */
export function isHarnessPath(path: string): boolean {
  return ALWAYS_FORBIDDEN.some((pattern) => matchGlob(pattern, path));
}

/**
 * Check the policy itself, before a task is published.
 *
 * A pattern is a path-shaped string; the same normalisation applies. `**` is
 * legal inside a pattern, so it is checked segment by segment.
 */
export function validatePatchPolicy(policy: PatchPolicy): string[] {
  const errors: string[] = [];
  const check = (label: string, patterns: readonly string[] | undefined) => {
    if (patterns === undefined) return;
    if (!Array.isArray(patterns)) {
      errors.push(`${label} must be an array of relative globs`);
      return;
    }
    for (const raw of patterns) {
      const segments = String(raw).split("/");
      if (String(raw).includes("\\") || String(raw).startsWith("/") || /^[a-zA-Z]:/.test(String(raw))) {
        errors.push(`${label}: "${raw}" is not a relative POSIX glob`);
        continue;
      }
      if (segments.some((s) => s === "..")) {
        errors.push(`${label}: "${raw}" escapes the workspace`);
        continue;
      }
      if (segments.some((s) => s === "" || s === ".")) {
        errors.push(`${label}: "${raw}" has an empty or "." segment`);
        continue;
      }
      if (segments.some((s) => s.includes("**") && s !== "**")) {
        errors.push(`${label}: "${raw}" uses "**" inside a segment; use a whole segment`);
      }
    }
  };
  check("allowedPaths", policy.allowedPaths);
  check("forbiddenPaths", policy.forbiddenPaths);
  if (policy.allowedPaths && policy.allowedPaths.length === 0) {
    // An empty allowlist means "nothing may change". That is a legal policy but
    // almost always a mistake, so it is refused rather than silently locking
    // every candidate out of a task nobody can pass.
    errors.push("allowedPaths is empty: no patch could ever satisfy it");
  }
  return errors;
}

/**
 * Apply a patch policy to the files a diff touches.
 *
 * Order matters only for the message: a `.git/config` edit is reported as a
 * harness edit even when an allowlist would also have excluded it, because the
 * specific reason is the one an operator can act on.
 */
export function checkPatchPolicy(
  files: readonly ChangedFile[],
  policy: PatchPolicy = {},
): PatchPolicyResult {
  const violations: PatchViolation[] = [];
  const normalised: string[] = [];

  for (const file of files) {
    const path = normalisePatchPath(file.path);
    if (path === null) {
      violations.push({
        path: String(file.path),
        code: "bad_path",
        detail: "path is not a relative POSIX path; a patch may not name it",
      });
      continue;
    }
    normalised.push(path);

    for (const candidate of [path, file.previousPath ? normalisePatchPath(file.previousPath) : null]) {
      if (candidate === null) continue;

      if (isHarnessPath(candidate)) {
        violations.push({
          path: candidate,
          code: "harness_edit",
          detail: "the evaluator, hidden tests, harness and .git are never editable by a candidate",
        });
        continue;
      }

      if (!policy.allowTestEdits && isTestPath(candidate)) {
        violations.push({
          path: candidate,
          code: "test_edit",
          detail: "the patch edits test code; this task does not allow it",
        });
      }

      if (policy.forbiddenPaths?.some((pattern) => matchGlob(pattern, candidate))) {
        violations.push({
          path: candidate,
          code: "forbidden_path",
          detail: "the task forbids this path",
        });
      }

      if (policy.allowedPaths && !policy.allowedPaths.some((pattern) => matchGlob(pattern, candidate))) {
        violations.push({
          path: candidate,
          code: "outside_allowed",
          detail: "the patch is outside this task's allowed paths",
        });
      }
    }

    // The allowlist check above runs on the pre-rename path too; a rename out of
    // an allowed directory and into a forbidden one must be caught in both
    // directions, which is why both are tested rather than only the new name.
    if (file.binary) {
      violations.push({
        path,
        code: "binary_change",
        detail: "binary changes cannot be reviewed and are flagged",
      });
    }
  }

  // A change that could not be named (a rename with no previous path) is already
  // a bad_path entry above; nothing else is inferred.
  return { ok: violations.length === 0, violations, files: normalised };
}

/** One line for the runner's evidence detail, naming the first cause. */
export function describePatchViolations(violations: readonly PatchViolation[]): string {
  if (violations.length === 0) return "patch stays inside the declared scope";
  const first = violations[0]!;
  const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : "";
  return `${first.code} at ${first.path}: ${first.detail}${more}`;
}
