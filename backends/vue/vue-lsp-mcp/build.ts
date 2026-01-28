#!/usr/bin/env bun
/**
 * Build script for vue-lsp-mcp
 */

import { $ } from "bun";

console.log("Building vue-lsp-mcp...");

// Build with Bun
await $`bun build src/index.ts --outdir dist --target node --format esm`.quiet();
console.log("Built index.js");

// Generate type declarations
console.log("Generating type declarations...");
await $`tsc --emitDeclarationOnly`.quiet();

console.log("Build complete!");
