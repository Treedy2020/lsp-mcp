import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-vue-strict-${Date.now()}`);

describe("Vue Strict Semantic Dependencies", () => {
  let client: McpTestClient;
  let vueFile: string;

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "vue-strict-fixture", version: "0.0.0" }));
    vueFile = path.join(TEST_DIR, "src", "App.vue");
    fs.writeFileSync(
      vueFile,
      `<script setup lang="ts">\n` +
      `const name = "world"\n` +
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
        LSP_MCP_VUE_FORCE_MISSING_SEMANTIC_DEPS: "true",
      },
    });

    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should return actionable install guidance in strict mode", async () => {
    await client.callTool("switch_workspace_for_language", { language: "vue", path: TEST_DIR });
    const result = await client.callTool("hover", { file: vueFile, line: 2, column: 8 });

    expect(result.error).toBe("SEMANTIC_DEPENDENCIES_MISSING");
    expect(result.error_code).toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(result.resolved_language).toBe("vue");
    expect(result.strict_mode).toBe(true);
    expect(result.missing_packages).toContain("typescript");
    expect(result.missing_packages).toContain("@vue/language-server");
    expect(Array.isArray(result.install_commands)).toBe(true);
    expect(String(result.install_commands?.[0] || "")).toContain("pnpm add -D typescript @vue/language-server");
    expect(result.code).toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(result.required_packages).toContain("typescript");
    expect(result.required_packages).toContain("@vue/language-server");
    expect(String(result.install_example)).toContain("pnpm add -D typescript @vue/language-server");
  });

  it("should expose structured missing dependency guidance in doctor output", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("doctor", {});
    const vueChecks = result.workspaceDependencyChecks?.vue;
    const vueChain = result.languageCommandChains?.vue;

    expect(vueChecks?.strict_mode).toBe(true);
    expect(Array.isArray(vueChecks?.projects)).toBe(true);
    expect(vueChecks.projects.length).toBeGreaterThan(0);
    expect(vueChecks.projects[0].missing_packages).toContain("typescript");
    expect(vueChecks.projects[0].missing_packages).toContain("@vue/language-server");
    expect(Array.isArray(vueChecks.projects[0].install_commands)).toBe(true);
    expect(String(vueChecks.projects[0].install_commands?.[0] || "")).toContain("pnpm add -D typescript @vue/language-server");
    expect(vueChain?.dependency_status).toBe("missing");
    expect(Array.isArray(vueChain?.commands)).toBe(true);
    expect(String(vueChain?.commands?.join(" ") || "")).toContain("pnpm add -D typescript @vue/language-server");
  });
});
