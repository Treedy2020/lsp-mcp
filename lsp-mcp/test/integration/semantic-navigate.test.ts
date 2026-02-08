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

  it("should support fast mode with lighter workflow", async () => {
    const result = await client.callTool("semantic_navigate", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25,
      mode: "fast",
      reference_preview: 5,
    });

    expect(result.tool).toBe("semantic_navigate");
    expect(result.mode).toBe("fast");
    expect(result.summary?.mode).toBe("fast");
    expect(result.steps?.definition).toBeDefined();
    expect(result.steps?.references).toBeDefined();
    expect(result.steps?.read_file_with_hints?.status).toBe("skipped");
  }, 60000);

  it("should support strategy ordering", async () => {
    const definitionFirst = await client.callTool("semantic_navigate", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25,
      mode: "fast",
      strategy: "definition_first",
    });
    const referencesFirst = await client.callTool("semantic_navigate", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25,
      mode: "fast",
      strategy: "references_first",
    });

    expect(definitionFirst.strategy).toBe("definition_first");
    expect(referencesFirst.strategy).toBe("references_first");
    expect(Array.isArray(definitionFirst.summary?.step_order)).toBe(true);
    expect(Array.isArray(referencesFirst.summary?.step_order)).toBe(true);
    expect(definitionFirst.summary.step_order[0]).toBe("definition");
    expect(referencesFirst.summary.step_order[0]).toBe("references");
  }, 60000);
});
