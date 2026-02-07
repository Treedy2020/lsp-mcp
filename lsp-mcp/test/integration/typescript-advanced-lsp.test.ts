import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-ts-advanced-${Date.now()}`);
const TEST_FILE = path.join(TEST_DIR, "src", "main.ts");

describe("TypeScript Advanced LSP Tools", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "ts-advanced-fixture", private: true, version: "0.0.0" })
    );
    fs.writeFileSync(
      path.join(TEST_DIR, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2020", module: "ESNext", strict: true } })
    );
    fs.writeFileSync(
      TEST_FILE,
      [
        "interface Greeter {",
        "  greet(name: string): string;",
        "}",
        "",
        "class ConsoleGreeter implements Greeter {",
        "  greet(name: string): string {",
        "    return `Hello ${name}`;",
        "  }",
        "}",
        "",
        "const greeter: Greeter = new ConsoleGreeter();",
        "greeter.greet('world');",
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

  it("should resolve implementation for interface method", async () => {
    const result = await client.callTool("implementation", { file: TEST_FILE, line: 2, column: 4 });
    expect(result.error).toBeUndefined();
    expect(result.file).toBeDefined();
    expect(result.line).toBeGreaterThan(0);
  });

  it("should resolve type definition for typed variable", async () => {
    const result = await client.callTool("type_definition", { file: TEST_FILE, line: 11, column: 16 });
    expect(result.error).toBeUndefined();
    expect(result.file).toBeDefined();
    expect(result.line).toBeGreaterThan(0);
  });

  it("should prepare rename with editable range", async () => {
    const result = await client.callTool("prepare_rename", { file: TEST_FILE, line: 11, column: 7 });
    expect(result.canRename).toBe(true);
    expect(result.range).toBeDefined();
    expect(result.range.start.line).toBeGreaterThan(0);
  });
});
