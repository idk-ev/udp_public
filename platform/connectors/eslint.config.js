/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// ESLint flat config of the connector service.
//
// Deliberately stricter than gui/eslint.config.js — there no-explicit-any is
// set to "off". Here it is an error, and for a concrete reason: the 29
// connectors are ported with the work split up. A single lenient module
// devalues the typing for all the others, because then exactly the unwieldy
// external data runs through the program unchecked again.
//
// The load-bearing rule reads: external data enters the program as `unknown`
// and is NARROWED, never ASSERTED. That is why `as` is blocked entirely (as
// const stays allowed, that is not a type assertion) and `x!` likewise.
//
// noInlineConfig blocks eslint-disable comments completely. Without it the ban
// would only be a request: whoever ports under time pressure writes the
// exception themselves otherwise. A real exception belongs in the review, not
// in a comment line.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "eslint.config.js", "test/hardening/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.hardening.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      // No emergency exits.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],

      // Covers the cases in which a check only looks as if it checked something.
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowNullableObject: true, allowNullableString: true, allowNullableNumber: false },
      ],

      // A forgotten await on an upsert means: the error vanishes without a trace.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
