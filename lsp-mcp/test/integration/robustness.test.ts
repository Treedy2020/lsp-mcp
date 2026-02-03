import { describe, it, expect, afterAll } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), "lsp-mcp-test-robustness-" + Date.now());

fs.mkdirSync(TEST_DIR, { recursive: true });

describe("Robustness Tests", () => {
  let client: McpTestClient;

  afterAll(() => {
    if (client) client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should handle corrupted config file gracefully", async () => {
    // Create a config with missing/null fields that might cause crashes
    // Without our fix, accessing config.languages.python.enabled would crash
    const corruptConfig = {
      languages: {
        python: null, 
        typescript: { enabled: true }
      }
    };
    
    fs.writeFileSync(path.join(TEST_DIR, ".lsp-mcp.json"), JSON.stringify(corruptConfig));

    client = new McpTestClient(SERVER_PATH, { cwd: TEST_DIR });
    
    // Server should start and respond to status
    const status = await client.callTool("status", {});
    
    expect(status.server).toBe("lsp-mcp");
    
    // List backends should also work without crashing
    const list = await client.callTool("list_backends", {});
    expect(list.backends).toBeDefined();
    
    // Python should be absent from list/status or handled safely
    // (Since we filter out falsy configs in loop)
    // Wait, getStatus() adds "configured but not started".
    // My fix: if (config && config.enabled...)
    // So if python: null, it skips the if, so it won't be in status list.
    const pythonStatus = list.backends.find((b: any) => b.name === "python");
    expect(pythonStatus).toBeDefined();
    expect(pythonStatus.enabled).toBe(false);
    
    // TypeScript should be there
    const tsStatus = list.backends.find((b: any) => b.name === "typescript");
    expect(tsStatus).toBeDefined();
  });
});
