import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
  ...nextVitals,
  ...nextTs,
  ...tseslint.configs.strict,
  {
    plugins: {
      import: importPlugin,
      "unused-imports": unusedImports,
    },
    rules: {
      // Forbid `any` and unsafe non-null assertions outright (justify exceptions inline).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Disallow stray console usage in source; use the structured logger instead.
      "no-console": "error",
      // Import hygiene.
      "import/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  // The logger module is the one place console access is allowed.
  {
    files: ["src/lib/logger.ts"],
    rules: { "no-console": "off" },
  },
  // Test + config files may relax a few strict rules.
  {
    files: [
      "tests/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
      "*.config.{ts,mts,js,mjs,cjs}",
      "vitest.config.ts",
      "playwright.config.ts",
    ],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // Mock hoisting (vi.mock) and dynamic-import typing require flexibility.
      "import/order": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  // Disable formatting-related rules in favour of Prettier (must be last).
  prettier,
]);

export default eslintConfig;
