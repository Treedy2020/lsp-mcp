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
      line: 1,
      column: 10,
      direction: "both",
    });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].symbol.name).toBe("leaf");
    expect(Array.isArray(result.items[0].incoming)).toBe(true);
  });

  it("should return structured NOT_IMPLEMENTED for type hierarchy", async () => {
    const result = await client.callTool("type_hierarchy", {
      file: TEST_FILE,
      line: 1,
      column: 10,
      direction: "both",
    });
    expect(result.error_code).toBe("NOT_IMPLEMENTED");
    expect(result.strict_mode).toBe(true);
    expect(result.next_step).toBeDefined();
  });
});
