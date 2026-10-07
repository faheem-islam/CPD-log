import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default tseslint.config(
  { ignores: [".next/**", ".next-*/**", "tmp-*/**", "node_modules/**", ".data/**", "coverage/**", "test-results/**", "playwright-report/**", "next-env.d.ts", "screenshots/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends("next/core-web-vitals"),
  {
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // typescript-eslint 8.71 misreports `export default x` in plain JS config files as an unused variable.
    files: ["**/*.mjs"],
    rules: { "@typescript-eslint/no-unused-vars": "off", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  { files: ["scripts/**", "tests/**", "eval/**"], rules: { "no-console": "off" } },
);
