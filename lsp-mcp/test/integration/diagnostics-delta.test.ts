import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/zod");

describe("Diagnostics Delta", () => {
  let client: McpTestClient;
  const targetPath = "packages/zod/src/v4/core/util.ts";
  const tempRelativePath = "packages/zod/src/v4/core/__diag_delta_test__.ts";
  const tempAbsolutePath = path.join(WORKSPACE_ROOT, tempRelativePath);

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: WORKSPACE_ROOT });
    fs.writeFileSync(
      tempAbsolutePath,
      "const a: string = 1;\nconst b: number = '2';\nconst c: boolean = 3;\n",
      "utf8"
    );
  });

  afterAll(() => {
    try { fs.unlinkSync(tempAbsolutePath); } catch {}
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

  it("should support diagnostics_delta filtering and cursor paging", async () => {
    const baseline = await client.callTool("diagnostics_delta", { path: tempRelativePath });
    expect(baseline.tool).toBe("diagnostics_delta");

    const filtered = await client.callTool("diagnostics_delta", {
      path: tempRelativePath,
      severity: "error",
      source: "typescript",
      preview_limit: 1,
      hotspot_limit: 3,
      page_size: 1,
    });
    expect(filtered.tool).toBe("diagnostics_delta");
    expect(filtered.delta.filters.severity).toBe("error");
    expect(filtered.delta.filters.source).toBe("typescript");
    expect(filtered.delta.filters.hotspot_limit).toBe(3);
    expect(Array.isArray(filtered.delta.file_summary)).toBe(true);
    expect(Array.isArray(filtered.delta.top_hotspots)).toBe(true);
    expect(filtered.delta.top_hotspots.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(filtered.delta.changes_page)).toBe(true);
    expect(filtered.delta.added_count).toBeGreaterThanOrEqual(0);
    expect(typeof filtered.cursor_available).toBe("boolean");

    if (filtered.cursor_available && filtered.next?.arguments?.cursor) {
      const nextPage = await client.callTool("diagnostics_delta", {
        cursor: filtered.next.arguments.cursor,
        page_size: 1,
      });
      expect(nextPage.tool).toBe("diagnostics_delta");
      expect(Array.isArray(nextPage.delta.changes_page)).toBe(true);
    }
  }, 60000);
});
