import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/zod");

describe("TypeScript Integration (Zod)", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await client.callTool("switch_workspace", { path: WORKSPACE_ROOT });
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
  }, 60000);

  it("should find references for jsonStringifyReplacer", async () => {
    const result = await client.callTool("references", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.references[0].file).toContain("util.ts");
  }, 60000);
  
  it("should return inlay hints via read_file_with_hints", async () => {
      // We need to read a file that actually has hints.
      // util.ts had some according to previous manual test.
      const result = await client.callTool("read_file_with_hints", {
          file: "packages/zod/src/v4/core/util.ts"
      });
      
      // Look for type annotations inserted by our tool
      // "/*:" is the marker for type hint
      expect(result).toContain("/*:");
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
