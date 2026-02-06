import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/vitesse");
const FOOTER_FILE = path.join(WORKSPACE_ROOT, "src/components/TheFooter.vue");

describe("Vue Integration Deep (Vitesse)", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      throw new Error(`Benchmark workspace not found: ${WORKSPACE_ROOT}`);
    }
    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "true",
        LSP_MCP_VUE_ENABLED: "true",
        LSP_MCP_VUE_STRICT_SEMANTIC: "false",
        LSP_MCP_VUE_FORCE_MISSING_SEMANTIC_DEPS: "true",
      },
    });
    await client.callTool("switch_workspace", { path: WORKSPACE_ROOT });
  });

  afterAll(() => {
    client.kill();
  });

  it("should support search -> hover -> definition -> references flow", async () => {
    const search = await client.callTool("search", {
      query: "toggleDark",
      path: WORKSPACE_ROOT,
      preview_limit: 5,
    });
    expect(search.error).toBeUndefined();
    expect(Array.isArray(search.matches)).toBe(true);
    expect(search.matches.length).toBeGreaterThan(0);

    const hover = await client.callTool("hover", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });
    expect(hover.error).toBeUndefined();
    expect(hover.contents).toBeDefined();

    const definition = await client.callTool("definition", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });
    expect(definition.error).toBeUndefined();
    expect(definition.file).toBeDefined();

    const references = await client.callTool("references", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
      page_size: 2,
    });
    expect(references.error).toBeUndefined();
    expect(Array.isArray(references.references)).toBe(true);
    expect(references.references.length).toBeGreaterThan(0);
    if (references.page?.has_more) {
      expect(references.next?.tool).toBe("expand_result");
      const next = await client.callTool("expand_result", {
        cursor: references.next.arguments.cursor,
        page_size: 2,
      });
      expect(next.tool).toBe("references");
      expect(Array.isArray(next.references)).toBe(true);
    }

    const diagnostics = await client.callTool("diagnostics", {
      path: WORKSPACE_ROOT,
      summary_only: true,
      preview_limit: 5,
    });
    expect(diagnostics.error).toBeUndefined();
    expect(diagnostics.summary).toBeDefined();
    expect(diagnostics.preview).toBeDefined();
  }, 120000);
});
