import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const TEST_DIR = path.join(os.tmpdir(), `lsp-mcp-semantic-session-${Date.now()}`);
const TS_FILE = path.join(TEST_DIR, "src", "index.ts");

describe("Semantic Session Start", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    fs.mkdirSync(path.dirname(TS_FILE), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "package.json"), JSON.stringify({ name: "session-fixture", version: "0.0.0" }));
    fs.writeFileSync(TS_FILE, "export const value = 1;\n");

    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "true",
        LSP_MCP_VUE_ENABLED: "false",
      },
    });
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should bootstrap typescript semantic session from file path", async () => {
    const result = await client.callTool("semantic_session_start", {
      file: TS_FILE,
      start_backend: false,
    });
    expect(result.success).toBe(true);
    expect(result.resolved_language).toBe("typescript");
    expect(result.resolved_workspace).toBe(TEST_DIR);
    expect(result.dependency_status).toBe("ok");
    expect(Array.isArray(result.commands)).toBe(true);
    expect(String(result.next_step || "")).toContain("hover(");
    expect(result.commands.some((c: string) => c.includes(TS_FILE))).toBe(true);
    expect(Array.isArray(result.feature_probe_sequence)).toBe(true);
    expect(result.feature_probe_sequence.length).toBeGreaterThan(3);
    expect(result.feature_probe_sequence.some((s: any) => s.feature === "moniker")).toBe(true);
    expect(typeof result.feature_probe_sequence[0].expected_latency_ms?.p50).toBe("number");
    expect(typeof result.feature_probe_sequence[0].expected_latency_ms?.p95).toBe("number");
    expect(Array.isArray(result.feature_probe_sequence[0].failure_signatures)).toBe(true);
    expect(result.feature_probe_sequence[0].failure_signatures.length).toBeGreaterThan(0);

    const status = await client.callTool("status", {});
    expect(status.workspaces.overrides.typescript).toBe(TEST_DIR);
  });

  it("should return structured error when language is missing", async () => {
    const result = await client.callTool("semantic_session_start", {});
    expect(result.success).toBe(false);
    expect(result.error_code).toBe("SEMANTIC_SESSION_LANGUAGE_REQUIRED");
    expect(Array.isArray(result.install_commands)).toBe(true);
    expect(result.strict_mode).toBe(true);
  });
});
