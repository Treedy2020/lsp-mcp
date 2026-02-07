import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/vitesse");
const FOOTER_FILE = path.join(WORKSPACE_ROOT, "src/components/TheFooter.vue");

function ensureBenchmarkDeps(): void {
  if (!fs.existsSync(WORKSPACE_ROOT)) {
    throw new Error(`Benchmark workspace not found: ${WORKSPACE_ROOT}`);
  }
  const hasTypeScript = fs.existsSync(path.join(WORKSPACE_ROOT, "node_modules/typescript"));
  const hasVueLanguageServer = fs.existsSync(path.join(WORKSPACE_ROOT, "node_modules/@vue/language-server"));
  if (!hasTypeScript || !hasVueLanguageServer) {
    throw new Error(
      "Vitesse benchmark missing Vue semantic deps. Run `pnpm install` in benchmarks/vitesse before this test."
    );
  }
}

async function createVueClient(forceMissingDeps: boolean): Promise<McpTestClient> {
  const client = new McpTestClient(SERVER_PATH, {
    env: {
      ...process.env,
      LSP_MCP_PYTHON_ENABLED: "false",
      LSP_MCP_TYPESCRIPT_ENABLED: "true",
      LSP_MCP_VUE_ENABLED: "true",
      LSP_MCP_VUE_STRICT_SEMANTIC: "true",
      LSP_MCP_VUE_FORCE_MISSING_SEMANTIC_DEPS: forceMissingDeps ? "true" : "false",
    },
  });
  await client.callTool("switch_workspace", { path: WORKSPACE_ROOT });
  await client.callTool("switch_workspace_for_language", { language: "typescript", path: WORKSPACE_ROOT });
  await client.callTool("switch_workspace_for_language", { language: "vue", path: WORKSPACE_ROOT });
  return client;
}

describe("Vue Benchmark Semantic Dependency Recovery (Vitesse)", () => {
  it("should error with install guidance when semantic deps are missing, then recover after install", async () => {
    ensureBenchmarkDeps();

    const missingClient = await createVueClient(true);
    const missing = await missingClient.callTool("hover", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });
    missingClient.kill();

    expect(missing.error_code).toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(Array.isArray(missing.install_commands)).toBe(true);
    expect(String(missing.install_commands?.[0] || "")).toContain("pnpm add -D typescript @vue/language-server");

    const recoveredClient = await createVueClient(false);
    const recovered = await recoveredClient.callTool("hover", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });
    recoveredClient.kill();

    expect(recovered.error_code).not.toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(recovered.error).toBeUndefined();
    expect(recovered.contents).toBeDefined();
  }, 120000);
});
