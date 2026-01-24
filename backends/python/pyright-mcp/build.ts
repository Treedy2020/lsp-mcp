import { $ } from "bun";

console.log("Building with Bun...");

// 清理 dist 目录
await $`rm -rf dist`;

// 使用 Bun 构建主入口（打包成单文件）
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: [
    "@modelcontextprotocol/sdk",
    "vscode-jsonrpc",
    "vscode-languageserver-protocol",
    "zod",
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built ${result.outputs.length} files`);

// 生成类型声明文件
console.log("Generating type declarations...");
await $`bunx tsc --emitDeclarationOnly --declaration --outDir dist`;

// 添加 shebang 到入口文件
const indexPath = "./dist/index.js";
const content = await Bun.file(indexPath).text();
if (!content.startsWith("#!")) {
  await Bun.write(indexPath, `#!/usr/bin/env node\n${content}`);
}

console.log("Build complete!");
