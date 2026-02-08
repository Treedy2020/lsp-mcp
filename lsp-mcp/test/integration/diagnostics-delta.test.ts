import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/zod");

describe("Diagnostics Delta", () => {
  let client: McpTestClient;
  const targetPath = "packages/zod/src/v4/core/util.ts";

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: WORKSPACE_ROOT });
  });

  afterAll(() => {
    client.kill();
  });

  it("should return baseline then incremental diagnostics delta", async () => {
    const first = await client.callTool("diagnostics_delta", { path: targetPath });
    expect(first.tool).toBe("diagnostics_delta");
    expect(first.delta).toBeDefined();
    expect(first.delta.baseline_created).toBe(true);
    expect(typeof first.delta.current_count).toBe("number");
    expect(typeof first.delta.added_count).toBe("number");
    expect(typeof first.confidence).toBe("number");

    const second = await client.callTool("diagnostics_delta", { path: targetPath });
    expect(second.delta.baseline_created).toBe(false);
    expect(second.delta.added_count).toBe(0);
    expect(second.delta.removed_count).toBe(0);
  }, 60000);
});
