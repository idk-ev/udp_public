/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

// The real rules, pointed at the proofs under test/hardening/ (which the real
// config ignores and tsconfig.json excludes).
import config from "./eslint.config.js";

export default [
  ...config.filter((entry) => !entry.ignores?.includes("test/hardening/")),
  {
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.hardening.json",
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
      },
    },
  },
];
