import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TS_WORKSPACE = path.resolve(__dirname, "../../../benchmarks/zod");
const PY_WORKSPACE = path.resolve(__dirname, "../../../benchmarks/fastapi");

describe("Type Hierarchy and Inlay Resolve Fallback", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_SINGLETON_BACKEND: "false",
      },
    });
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: TS_WORKSPACE });
    await client.callTool("switch_workspace_for_language", { language: "python", path: PY_WORKSPACE });
  });

  afterAll(() => {
    client.kill();
  });

  it("should provide approximate type_hierarchy instead of NOT_IMPLEMENTED", async () => {
    const result = await client.callTool("type_hierarchy", {
      file: "packages/zod/src/v3/types.ts",
      line: 731,
      column: 22,
      direction: "both",
    });

    expect(result.error_code).not.toBe("NOT_IMPLEMENTED");
    expect(result.tool).toBe("type_hierarchy");
    expect(result.fallback_used).toBe(true);
    expect(result.approximate).toBe(true);
    expect(result.hierarchy).toBeDefined();
    expect(Array.isArray(result.hierarchy.supertypes)).toBe(true);
    expect(Array.isArray(result.hierarchy.subtypes)).toBe(true);
  }, 60000);

  it("should resolve inlay hint via fallback when backend lacks native resolver", async () => {
    const result = await client.callTool("inlay_hint_resolve", {
      file: "fastapi/applications.py",
      line: 1336,
      column: 9,
    });

    expect(result.error_code).not.toBe("NOT_IMPLEMENTED");
    expect(result.fallback_used).toBe(true);
    expect(result.approximate).toBe(true);
    if (result.error_code) {
      expect(["NO_INLAY_HINT_FOUND", "INLAY_HINT_RESOLVE_FALLBACK_ERROR"]).toContain(result.error_code);
    } else {
      expect(result.tool).toBe("inlay_hint_resolve");
      expect(result.hint).toBeDefined();
    }
  }, 60000);
});
