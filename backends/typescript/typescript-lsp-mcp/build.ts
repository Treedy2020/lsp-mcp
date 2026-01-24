/**
 * Build script for typescript-lsp-mcp using Bun
 */

import { $ } from "bun";

console.log("Building with Bun...");

// Build with Bun
await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  external: ["typescript"],
});

console.log("Built index.js");

// Generate type declarations
console.log("Generating type declarations...");
await $`bunx tsc --declaration --emitDeclarationOnly --outDir dist`;

console.log("Build complete!");
