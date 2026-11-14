import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const typeLibraryReference = (comment) =>
  comment.type === "Line" && /^\/ <reference lib="[a-z.]+" \/>$/.test(comment.value);

const noComments = {
  meta: { type: "suggestion", messages: { comment: "Comments are not allowed in code." } },
  create: (context) => ({
    Program: () => {
      for (const comment of context.sourceCode.getAllComments()) {
        if (!typeLibraryReference(comment))
          context.report({ loc: comment.loc, messageId: "comment" });
      }
    },
  }),
};

const killsByName = String.raw`\b(pkill|killall)\b`;
const noKillByName = `Never kill a process by name in e2e code: one host runs the live herdr server, the lanes, and other workers' tests, and a name match kills them all. Stop only the lab session this test started, by its own --session name, or your own process by pid.`;

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "packages/board/src/vendor/",
      "packages/extension/vendor/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    plugins: { fleet: { rules: { "no-comments": noComments } } },
    rules: {
      "fleet/no-comments": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "no-unreachable": "error",
      complexity: ["error", 10],
      "max-lines": ["error", { max: 500, skipBlankLines: false, skipComments: false }],
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: false, skipComments: false }],
      "max-depth": ["error", 3],
      "max-nested-callbacks": ["error", 3],
      eqeqeq: "error",
    },
  },
  {
    files: ["e2e/**/*.ts"],
    ignores: ["e2e/extension/kill-guard.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=/${killsByName}/]`, message: noKillByName },
        { selector: `TemplateElement[value.raw=/${killsByName}/]`, message: noKillByName },
      ],
    },
  },
  { files: ["packages/board/**/*.tsx"], extends: [reactHooks.configs.flat["recommended-latest"]] },
  { files: ["**/*.js", "**/*.cjs"], extends: [tseslint.configs.disableTypeChecked] },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable" } },
  },
);
