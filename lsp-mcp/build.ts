#!/usr/bin/env bun
/**
 * Build script for lsp-mcp
 *
 * Uses Bun to build and bundle the TypeScript source.
 */

import { $ } from "bun";
import * as path from "path";
import * as fs from "fs";

// Resolve paths
const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const BACKENDS_DIR = path.join(PROJECT_ROOT, "backends");
const DIST_DIR = path.resolve(import.meta.dir, "dist");
const BUNDLED_DIR = path.join(DIST_DIR, "bundled");

async function buildBackend(name: string, dir: string) {
  console.log(`Building ${name} backend...`);
  const backendPath = path.join(BACKENDS_DIR, dir);

  // Install dependencies and build
  if (dir.includes("python-lsp-mcp")) {
    // For python-lsp-mcp, we just copy the source since it's Python
    // We'll rely on uv to run it from source
    console.log(`Copying ${name} source...`);
    // We don't build python-lsp-mcp, we will bundle the source
  } else {
    // For TypeScript backends
    await $`cd ${backendPath} && bun install && bun run build`;
  }
}

async function copyBackend(name: string, dir: string) {
  console.log(`Bundling ${name}...`);
  const sourcePath = path.join(BACKENDS_DIR, dir);
  const targetPath = path.join(BUNDLED_DIR, name);

  await $`mkdir -p ${targetPath}`;

  if (dir.includes("python-lsp-mcp")) {
    // Copy Python source
    await $`cp -r ${path.join(sourcePath, "src")} ${targetPath}/`;
    await $`cp -r ${path.join(sourcePath, "pyproject.toml")} ${targetPath}/`;
    await $`cp -r ${path.join(sourcePath, "README.md")} ${targetPath}/`;
    // Also copy uv.lock if it exists
    if (fs.existsSync(path.join(sourcePath, "uv.lock"))) {
      await $`cp ${path.join(sourcePath, "uv.lock")} ${targetPath}/`;
    }
  } else {
    // Copy TypeScript build artifacts
    await $`cp -r ${path.join(sourcePath, "dist")} ${targetPath}/`;
    await $`cp ${path.join(sourcePath, "package.json")} ${targetPath}/`;
    // We also need dependencies for the bundled backend
    // For now, we'll assume node_modules are handled or bundled backends are self-contained enough
    // Ideally, we should bundle deps or use bun build --compile
  }
}

async function build() {
  console.log("Building lsp-mcp...");

  // Clean dist
  await $`rm -rf dist`;

  // Build lsp-mcp with Bun
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "external",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Create bundled directory
  await $`mkdir -p ${BUNDLED_DIR}`;

  // Build and copy backends
  // 1. TypeScript Backend
  await buildBackend("typescript", "typescript/typescript-lsp-mcp");
  await copyBackend("typescript", "typescript/typescript-lsp-mcp");

  // 2. Pyright Backend (TS implementation)
  await buildBackend("pyright", "python/pyright-mcp");
  await copyBackend("pyright", "python/pyright-mcp");

  // 3. Python Backend (Rope/Python implementation)
  // No build step needed for Python, just copy
  await copyBackend("python", "python/python-lsp-mcp");

  // 4. Vue Backend
  await buildBackend("vue", "vue/vue-lsp-mcp");
  await copyBackend("vue", "vue/vue-lsp-mcp");


  // Ensure shebang is at the top of the output file
  const indexPath = "./dist/index.js";
  const content = await Bun.file(indexPath).text();
  // Only add shebang if not already present
  if (!content.startsWith("#!/")) {
    await Bun.write(indexPath, `#!/usr/bin/env node\n${content}`);
  }

  // Make executable
  await $`chmod +x ${indexPath}`;

  console.log("Build complete! Backends bundled in ./dist/bundled/");
}

build().catch((error) => {
  console.error("Build error:", error);
  process.exit(1);
});
