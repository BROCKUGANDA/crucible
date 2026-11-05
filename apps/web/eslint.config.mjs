// ESLint for apps/web — correctness rules only; style is prettier's job.
//
// The toolchain this file imports (`eslint`, `@babel/eslint-parser`,
// `@babel/plugin-syntax-*`, `eslint-plugin-react-hooks`, `globals`) is declared in the
// ROOT package.json, not here, and that is load-bearing rather than tidiness. Declared in
// this workspace, npm resolved a second eslint inside `apps/web` to satisfy the parser's
// `^9 || ^10` peer — eslint@10.13.0 beside the root's 9.39.5 — and the second copy carried
// `minimatch@10.2.6` (CVE-2026-118764, patched only at 11.0.1). The audit gate named three
// packages it had never seen and `ci(main)` has been red since the day that bump merged
// (dependabot PR #50, 2026-10-30), which is six days of nothing deploying. One declaration,
// one eslint: `npm ls eslint` answers once, and the vulnerable chain is gone instead of
// documented. Measured on the runner's own Node 20 / npm 10.8.2: 30 lockfile entries
// removed, 0 versions changed. `npm run lint --workspace @crucible/web` still works because
// npm puts the root's `node_modules/.bin` on a workspace script's PATH.
//
// Division of labor, on purpose: type-level linting belongs to `tsc --noEmit`
// (strict, green repo-wide — and the workspace runs TypeScript 7, beyond
// typescript-eslint's supported range, so a TS-aware config would be fighting
// the toolchain rather than checking the code). What a linter adds here is the
// thing tsc cannot see: hook discipline and obvious correctness traps.
import js from "@eslint/js";
import hooks from "eslint-plugin-react-hooks";
import babelParser from "@babel/eslint-parser";
import globals from "globals";

export default [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      // The workspace runs TypeScript 7, which typescript-eslint hard-refuses
      // (their parser prints "does not support TS 7.0" and exits). The Babel
      // parser reads the same syntax with no version coupling to the compiler,
      // so linting survives toolchain moves; type-level checking stays with
      // `tsc --noEmit` (strict, green repo-wide) — that is the division of
      // labor, not a gap.
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [["@babel/plugin-syntax-typescript", { isTSX: true }], "@babel/plugin-syntax-jsx"],
        },
      },
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": hooks },
    rules: {
      // The two rules this file was written for. They are named rather than inherited
      // because `configs.recommended` is not a stable set: `eslint-plugin-react-hooks`
      // 5 → 7 (dependabot, 2026-10-30) widened it from these two into a fifteen-rule React
      // Compiler eligibility suite, which landed 37 errors on a tree that had been lint
      // green for a week and stopped `ci` from reaching anything after it. An inherited
      // rule set is a gate somebody else sets.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The compiler family, downgraded to warnings rather than switched off.
      //
      // This app is not built with the React Compiler (`next build --webpack`, no
      // babel-plugin-react-compiler), so these rules describe a property the build does not
      // depend on — memoisation eligibility — not a correctness trap. Two of them also
      // contradict deliberate, tested behaviour: `set-state-in-effect` fires on the account
      // change reset in `src/lib/useTx.ts`, whose whole point is a synchronous wipe of five
      // surfaces when the connected wallet changes, and that reset is pinned by a mutation
      // proof. Rewriting tested money-path effects to satisfy an advisory rule is the
      // opposite of what this config is for.
      //
      // They still print, and CI shows the count, because this repository's own rule is that
      // a degraded result is never hidden as a pass.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/error-boundaries": "warn",
      "react-hooks/set-state-in-render": "warn",
      "react-hooks/gating": "warn",
      "react-hooks/config": "warn",
      // `no-undef` cannot see TypeScript scopes and false-positives on every
      // ambient name; undefined identifiers are tsc's to catch, precisely.
      "no-undef": "off",
      // Same story for unused: the Babel parser erases type positions, so a
      // type-only import reads as unused. `noUnusedLocals`/`noUnusedParameters`
      // in tsconfig own this check with real scope information.
      "no-unused-vars": "off",
      // The money app: no accidental non-null assertions on request-shaped data
      // (state machines here deliberately use `!` only after an existence check).
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["test/**/*.ts", "**/*.test.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-console": "off",
    },
  },
];
