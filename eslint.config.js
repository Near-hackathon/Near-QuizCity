import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "contract/target/**",
      "server/backups/**",
      "server/demo-accounts.json",
      "Gridwright Jam Pack/**",
      "household_*_sprites_v1.0/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "localStorage",
        "sessionStorage",
        "navigator",
        "alert",
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "global",
        "__dirname",
        "__filename",
        "require",
        "module",
      ],
    },
  },
  {
    files: ["web/*.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
