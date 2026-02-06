import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-singleton-${Date.now()}`);

describe("Backend Singleton", () => {
  let clientA: McpTestClient;
  let clientB: McpTestClient;
  const filePath = path.join(TEST_DIR, "src", "index.ts");

  beforeAll(async () => {
    fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "singleton-fixture", version: "0.0.0" }));
    fs.writeFileSync(filePath, "export const singletonMarker = 1;\n");

    const env = {
      ...process.env,
      LSP_MCP_PYTHON_ENABLED: "false",
      LSP_MCP_TYPESCRIPT_ENABLED: "true",
      LSP_MCP_VUE_ENABLED: "false",
      LSP_MCP_SINGLETON_BACKEND: "true",
    };

    clientA = new McpTestClient(SERVER_PATH, { env });
    clientB = new McpTestClient(SERVER_PATH, { env });

    await new Promise((r) => setTimeout(r, 500));
    await clientA.callTool("switch_workspace", { path: TEST_DIR });
    await clientB.callTool("switch_workspace", { path: TEST_DIR });
  });

  afterAll(() => {
    clientA.kill();
    clientB.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should proxy calls to the owning backend across CLI processes", async () => {
    const first = await clientA.callTool("hover", {
      file: filePath,
      line: 1,
      column: 14,
    });
    expect(first.error).toBeUndefined();

    const second = await clientB.callTool("hover", {
      file: filePath,
      line: 1,
      column: 14,
    });
    let resolved = second;
    for (let i = 0; i < 10 && resolved?.code === "BACKEND_SINGLETON_LOCKED"; i++) {
      await new Promise((r) => setTimeout(r, 80));
      resolved = await clientB.callTool("hover", {
        file: filePath,
        line: 1,
        column: 14,
      });
    }

    if (resolved?.code === "BACKEND_SINGLETON_LOCKED") {
      expect(resolved.language).toBe("typescript");
      return;
    }
    expect(resolved.error).toBeUndefined();
    expect(resolved.contents).toBeDefined();
  }, 120000);
});
