import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/zod");

describe("TypeScript Integration (Zod)", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: WORKSPACE_ROOT });
  });

  afterAll(() => {
    client.kill();
  });

  it("should hover over jsonStringifyReplacer", async () => {
    // packages/zod/src/v4/core/util.ts:218:25
    const result = await client.callTool("hover", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25
    });

    expect(result.contents).toContain("jsonStringifyReplacer");
    expect(result.resolved_workspace).toBe(WORKSPACE_ROOT);
    expect(typeof result.backend_instance_id).toBe("string");
  }, 60000);

  it("should find references for jsonStringifyReplacer", async () => {
    const result = await client.callTool("references", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.references[0].file).toContain("util.ts");
    expect(result.resolved_workspace).toBe(WORKSPACE_ROOT);
    expect(typeof result.backend_instance_id).toBe("string");
  }, 60000);
  
  it("should return inlay hints via read_file_with_hints", async () => {
      // We need to read a file that actually has hints.
      // util.ts had some according to previous manual test.
      const result = await client.callTool("read_file_with_hints", {
          file: "packages/zod/src/v4/core/util.ts"
      });

      const content = typeof result.result === "string" ? result.result : "";
      // Look for type annotations inserted by our tool
      // "/*:" is the marker for type hint
      expect(content).toContain("/*:");
      expect(result.resolved_workspace).toBe(WORKSPACE_ROOT);
      expect(typeof result.backend_instance_id).toBe("string");
  }, 60000);

  it("should support windowed inlay hint extraction", async () => {
    const result = await client.callTool("read_file_with_hints", {
      file: "packages/zod/src/v4/core/util.ts",
      start_line: 200,
      max_lines: 25,
    });

    const content = typeof result.result === "string" ? result.result : "";
    expect(content).toContain("File preview for");
    expect(content).toContain("lines 200-");
    expect(result.resolved_workspace).toBe(WORKSPACE_ROOT);
  }, 60000);

  it("should list symbols with query", async () => {
    const result = await client.callTool("symbols", {
      file: "packages/zod/src/v4/core/util.ts",
      query: "jsonStringify"
    });
    expect(result.count).toBeGreaterThan(0);
    expect(result.symbols[0].name).toContain("jsonStringify");
  });

  it("should provide completions", async () => {
    // packages/zod/src/v4/core/util.ts
    const result = await client.callTool("completions", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 10, // Random line inside file
      column: 1
    });
    expect(result.count).toBeGreaterThan(0);
  });
});
