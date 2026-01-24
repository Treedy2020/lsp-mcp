#!/usr/bin/env bun
/**
 * Build script for lsp-mcp
 *
 * Uses Bun to build and bundle the TypeScript source.
 */

import { $ } from "bun";

async function build() {
  console.log("Building lsp-mcp...");

  // Clean dist
  await $`rm -rf dist`;

  // Build with Bun
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

  // Ensure shebang is at the top of the output file
  const indexPath = "./dist/index.js";
  const content = await Bun.file(indexPath).text();
  // Only add shebang if not already present
  if (!content.startsWith("#!/")) {
    await Bun.write(indexPath, `#!/usr/bin/env node\n${content}`);
  }

  // Make executable
  await $`chmod +x ${indexPath}`;

  console.log("Build complete!");
}

build().catch((error) => {
  console.error("Build error:", error);
  process.exit(1);
});
