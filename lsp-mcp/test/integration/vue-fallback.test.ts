import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-vue-${Date.now()}`);

describe("Vue Fallback", () => {
  let client: McpTestClient;
  let vueFile: string;

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "vue-fixture", version: "0.0.0" }));
    vueFile = path.join(TEST_DIR, "src", "App.vue");
    fs.writeFileSync(
      vueFile,
      `<script setup lang="ts">\n` +
      `const name = "world"\n` +
      `function go() { return name }\n` +
      `</script>\n\n` +
      `<template>\n` +
      `  <div>{{ name }}</div>\n` +
      `</template>\n`,
    );

    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "false",
        LSP_MCP_VUE_ENABLED: "true",
      },
    });

    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should provide symbols for vue files", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("symbols", { file: vueFile });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it("should provide hover payload for vue identifiers", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("hover", { file: vueFile, line: 2, column: 8 });

    expect(result.error).toBeUndefined();
    expect(result.contents).toBeDefined();
  });

  it("should provide references payload for vue identifiers", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("references", { file: vueFile, line: 2, column: 8 });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.references)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it("should gracefully fallback for out-of-bounds cursor positions", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const hover = await client.callTool("hover", { file: vueFile, line: 2, column: 999 });
    const definition = await client.callTool("definition", { file: vueFile, line: 2, column: 999 });

    expect(typeof hover).toBe("object");
    expect(hover.error).toBeUndefined();
    expect(hover.contents).toBeDefined();

    expect(typeof definition).toBe("object");
    expect(definition.error).toBeUndefined();
    expect(definition.file).toBeDefined();
  });
});
