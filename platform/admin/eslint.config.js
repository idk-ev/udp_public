/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// ESLint flat config of the admin panel: the rules of
// platform/connectors/eslint.config.js, extended to .svelte files.
//
// External data enters as `unknown` and is NARROWED, never ASSERTED: `as` (other
// than `as const`) and `x!` are errors. noInlineConfig blocks eslint-disable
// comments, so an exception has to go through the review of this file.
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

const strictRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/strict-boolean-expressions": [
    "error",
    { allowNullableObject: true, allowNullableString: true, allowNullableNumber: false },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
};

export default tseslint.config(
  {
    ignores: ["build/", "build-cli/", ".svelte-kit/", "node_modules/", "eslint.config.js", "eslint.hardening.config.js", "test/hardening/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...svelte.configs["flat/recommended"],
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  { files: ["**/*.ts"], rules: strictRules },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser },
    },
    rules: strictRules,
  },
);
