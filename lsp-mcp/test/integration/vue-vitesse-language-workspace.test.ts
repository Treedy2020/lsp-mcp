import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/vitesse");
const FOOTER_FILE = path.join(WORKSPACE_ROOT, "src/components/TheFooter.vue");

describe("Vue Language Workspace", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      throw new Error(`Benchmark workspace not found: ${WORKSPACE_ROOT}`);
    }
    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "false",
        LSP_MCP_VUE_ENABLED: "true",
        LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "true",
      },
    });
  });

  afterAll(() => {
    client.kill();
  });

  it("should resolve vue tools with language-scoped workspace when global workspace differs", async () => {
    await client.callTool("switch_workspace", { path: os.tmpdir() });
    await client.callTool("switch_workspace_for_language", {
      language: "vue",
      path: WORKSPACE_ROOT,
    });

    const result = await client.callTool("definition", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });

    expect(result.code).not.toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(result.error).toBeUndefined();
    expect(typeof result.file).toBe("string");
  }, 120000);
});
