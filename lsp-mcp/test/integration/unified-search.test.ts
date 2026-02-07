import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-search-${Date.now()}`);
const MARKER = "SearchAutoStartMarker";

describe("Unified Search", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "search-fixture", version: "0.0.0" }));
    fs.writeFileSync(
      path.join(TEST_DIR, "src", "index.ts"),
      `export const ${MARKER} = "ok";\n` +
      `export const ${MARKER}Alias = ${MARKER};\n` +
      `export const ${MARKER}A = "a";\n` +
      `export const ${MARKER}B = "b";\n` +
      `export const ${MARKER}C = "c";\n`
    );

    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_VUE_ENABLED: "false",
      },
    });

    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should auto-start a backend for search without explicit path after workspace switch", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("search", { pattern: MARKER });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("should prefer language-specific workspace over global workspace", async () => {
    await client.callTool("switch_workspace", { path: os.tmpdir() });
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: TEST_DIR });
    const result = await client.callTool("search", { query: MARKER });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("should accept query alias for search pattern", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("search", { query: MARKER });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("should treat directory path as workspace scope for search", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("search", { query: MARKER, path: TEST_DIR });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("should return workspace_symbol matches without requiring pre-started backends", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("workspace_symbol", { query: MARKER });

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("should return compact preview metadata for large result sets", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("search", {
      pattern: MARKER,
      preview_limit: 2,
    });

    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBe(2);
    expect(result.page).toBeDefined();
    expect(result.page.has_more).toBe(true);
    expect(result.next).toBeDefined();
  });

  it("should support cursor pagination for search results", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const first = await client.callTool("search", {
      pattern: MARKER,
      page_size: 1,
    });

    expect(first.page).toBeDefined();
    expect(first.page.has_more).toBe(true);
    expect(first.next?.arguments?.cursor).toBeDefined();
    expect(first.next?.tool).toBe("expand_result");

    const second = await client.callTool("search", {
      cursor: first.next.arguments.cursor,
      page_size: 1,
    });
    expect(Array.isArray(second.matches)).toBe(true);
    expect(second.page.offset).toBe(1);
    expect(second.page.expires_at).toBeDefined();
  });

  it("should page via expand_result without tool-specific arguments", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const first = await client.callTool("search", {
      pattern: MARKER,
      page_size: 1,
    });

    const nextCursor = first.next?.arguments?.cursor;
    expect(nextCursor).toBeDefined();

    const expanded = await client.callTool("expand_result", {
      cursor: nextCursor,
      page_size: 1,
    });
    expect(expanded.tool).toBe("search");
    expect(Array.isArray(expanded.items)).toBe(true);
    expect(expanded.page.offset).toBe(1);
  });

  it("should reject invalid cursor signatures", async () => {
    const result = await client.callTool("expand_result", {
      cursor: "search:abc:def:o0",
      page_size: 1,
    });
    expect(result.error).toBeDefined();
  });

  it("should truncate project_structure previews with expansion hint", async () => {
    const result = await client.callTool("project_structure", {
      path: TEST_DIR,
      max_depth: 5,
      max_entries: 1,
    });

    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(text).toContain("Preview truncated");
  });

  it("should support cursor pagination for project_structure", async () => {
    const first = await client.callTool("project_structure", {
      path: TEST_DIR,
      page_size: 1,
    });
    expect(Array.isArray(first.lines)).toBe(true);
    expect(first.page).toBeDefined();
    expect(first.next?.tool).toBe("expand_result");

    const second = await client.callTool("expand_result", {
      cursor: first.next.arguments.cursor,
      page_size: 1,
    });
    expect(second.tool).toBe("project_structure");
    expect(Array.isArray(second.lines)).toBe(true);
  });

  it("should support cursor pagination for summarize_file", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const first = await client.callTool("summarize_file", {
      file: path.join(TEST_DIR, "src", "index.ts"),
      page_size: 1,
    });

    expect(Array.isArray(first.lines)).toBe(true);
    expect(first.next?.tool).toBe("expand_result");
    expect(first.next?.arguments?.cursor).toBeDefined();
  });

  it("should paginate references in compact mode", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const file = path.join(TEST_DIR, "src", "index.ts");
    const first = await client.callTool("references", {
      file,
      line: 1,
      column: 14,
      page_size: 1,
    });

    expect(Array.isArray(first.references)).toBe(true);
    expect(first.references.length).toBe(1);
    expect(first.count).toBeGreaterThan(1);
    expect(first.next?.tool).toBe("expand_result");

    const second = await client.callTool("expand_result", {
      cursor: first.next.arguments.cursor,
      page_size: 1,
    });
    expect(second.tool).toBe("references");
    expect(Array.isArray(second.references)).toBe(true);
    expect(second.references.length).toBe(1);
  });

  it("should return diagnostics summary/preview metadata", async () => {
    await client.callTool("switch_workspace", { path: TEST_DIR });
    const result = await client.callTool("diagnostics", {
      path: TEST_DIR,
      preview_limit: 1,
      summary_only: true,
    });

    expect(result.count).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.preview).toBeDefined();
  });
});
