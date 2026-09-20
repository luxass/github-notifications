import { defineConfig } from "oxfmt";

export default defineConfig({
  singleQuote: false,
  semi: true,
  sortPackageJson: true,
  sortImports: {
    groups: [
      ["type-import"],
      ["type-builtin", "value-builtin"],
      ["type-external", "value-external", "type-internal", "value-internal"],
      ["type-parent", "type-sibling", "type-index", "value-parent", "value-sibling", "value-index"],
      ["unknown"],
    ],
    newlinesBetween: true,
    order: "asc",
  },
  ignorePatterns: [
    "typed-router.d.ts",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
});
