import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/zod");

describe("Semantic Navigate", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: WORKSPACE_ROOT });
  });

  afterAll(() => {
    client.kill();
  });

  it("should run composite semantic workflow with structured steps", async () => {
    const result = await client.callTool("semantic_navigate", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25,
      query: "jsonStringifyReplacer",
      reference_preview: 10,
      hint_start_line: 200,
      hint_max_lines: 30,
    });

    expect(result.tool).toBe("semantic_navigate");
    expect(result.resolved_language).toBe("typescript");
    expect(result.resolved_workspace).toBe(WORKSPACE_ROOT);
    expect(result.steps).toBeDefined();
    expect(result.steps.definition).toBeDefined();
    expect(result.steps.references).toBeDefined();
    expect(result.steps.read_file_with_hints).toBeDefined();
    expect(typeof result.latency_ms).toBe("number");
    expect(typeof result.result_size).toBe("number");
    expect(typeof result.cursor_available).toBe("boolean");
    expect(typeof result.truncated).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.confidence_reason).toBe("string");
  }, 60000);
});
