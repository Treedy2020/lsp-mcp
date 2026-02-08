import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-ts-hierarchy-${Date.now()}`);
const TEST_FILE = path.join(TEST_DIR, "src", "flow.ts");

describe("TypeScript Hierarchy Tools", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "ts-hierarchy", private: true, version: "0.0.0" }));
    fs.writeFileSync(path.join(TEST_DIR, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", strict: true } }));
    fs.writeFileSync(
      TEST_FILE,
      [
        "import { readFileSync } from 'fs';",
        "const docsUrl = 'https://example.com/docs';",
        "",
        "interface NodeItem {",
        "  id: string;",
        "}",
        "",
        "function leaf(x: number): number {",
        "  return x + 1;",
        "}",
        "",
        "function callerA() {",
        "  return leaf(1);",
        "}",
        "",
        "function callerB() {",
        "  return leaf(2);",
        "}",
        "",
        "const data: NodeItem = {",
        "  id: 'x',",
        "};",
        "",
      ].join("\n")
    );

    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "true",
        LSP_MCP_VUE_ENABLED: "false",
      },
    });
    await new Promise((r) => setTimeout(r, 1000));
    await client.callTool("switch_workspace_for_language", { language: "typescript", path: TEST_DIR });
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should return call hierarchy for function symbol", async () => {
    const result = await client.callTool("call_hierarchy", {
      file: TEST_FILE,
      line: 8,
      column: 10,
      direction: "both",
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].symbol.name).toBe("leaf");
    expect(Array.isArray(result.items[0].incoming)).toBe(true);
  });

  it("should return type hierarchy via native support or fallback", async () => {
    const result = await client.callTool("type_hierarchy", {
      file: TEST_FILE,
      line: 1,
      column: 10,
      direction: "both",
    });
    if (result.error_code === "NOT_IMPLEMENTED") {
      expect(result.strict_mode).toBe(true);
      expect(result.next_step).toBeDefined();
      return;
    }
    expect(result.tool).toBe("type_hierarchy");
    expect(result.strict_mode).toBe(true);
    expect(result.hierarchy).toBeDefined();
  });

  it("should return document highlights for symbol", async () => {
    const result = await client.callTool("document_highlight", {
      file: TEST_FILE,
      line: 8,
      column: 10,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.highlights)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it("should return code lens style summary", async () => {
    const result = await client.callTool("code_lens", {
      file: TEST_FILE,
      line: 8,
      column: 10,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.lenses)).toBe(true);
    expect(result.references_count).toBeGreaterThan(0);
  });

  it("should return nested selection ranges", async () => {
    const result = await client.callTool("selection_range", {
      file: TEST_FILE,
      line: 8,
      column: 10,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.ranges)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it("should return folding ranges", async () => {
    const result = await client.callTool("folding_range", {
      file: TEST_FILE,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.ranges)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it("should return document links (imports and urls)", async () => {
    const result = await client.callTool("document_link", {
      file: TEST_FILE,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.links)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.links.some((link: any) => link.target === "fs")).toBe(true);
    expect(result.links.some((link: any) => String(link.target).includes("https://example.com"))).toBe(true);
  });

  it("should return linked editing ranges for function symbol", async () => {
    const result = await client.callTool("linked_editing_range", {
      file: TEST_FILE,
      line: 8,
      column: 10,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.ranges)).toBe(true);
    expect(result.count).toBeGreaterThan(1);
  });

  it("should return semantic tokens for the file", async () => {
    const result = await client.callTool("semantic_tokens", {
      file: TEST_FILE,
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(typeof result.tokens[0].token_type).toBe("string");
  });

  it("should return moniker-style symbol identity", async () => {
    const result = await client.callTool("moniker", {
      file: TEST_FILE,
      line: 8,
      column: 10,
    });
    expect(result.error).toBeUndefined();
    expect(typeof result.identifier).toBe("string");
    expect(typeof result.symbol).toBe("string");
  });

  it("should resolve inlay hint at symbol position", async () => {
    const result = await client.callTool("inlay_hint_resolve", {
      file: TEST_FILE,
      line: 8,
      column: 17,
    });
    if (result.error) {
      expect(result.error).toContain("No inlay hint");
      return;
    }
    expect(typeof result.label).toBe("string");
  });
});
