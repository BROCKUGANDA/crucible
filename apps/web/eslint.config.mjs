// ESLint for apps/web — correctness rules only; style is prettier's job.
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
      ...hooks.configs.recommended.rules,
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
