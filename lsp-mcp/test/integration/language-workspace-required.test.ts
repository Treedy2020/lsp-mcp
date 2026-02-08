import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");

describe("Language Workspace Requirement", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_VUE_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "true",
      },
    });
  });

  afterAll(() => {
    client.kill();
  });

  it("should require explicit language workspace for semantic tools", async () => {
    const file = path.resolve(__dirname, "ts-zod.test.ts");
    const result = await client.callTool("hover", {
      file,
      line: 1,
      column: 1,
    });

    expect(result.error).toBe("LANGUAGE_WORKSPACE_REQUIRED");
    expect(result.error_code).toBe("LANGUAGE_WORKSPACE_REQUIRED");
    expect(result.strict_mode).toBe(true);
    expect(result.missing_workspace_for_language).toBe("typescript");
    expect(Array.isArray(result.install_commands)).toBe(true);
    expect(String(result.install_commands?.[0] || "")).toContain("switch_workspace_for_language");
    expect(Array.isArray(result.missing_packages)).toBe(true);
    expect(result.missing_packages.length).toBe(0);
    expect(result.required_workspace_scope).toBe("language");
    expect(result.language).toBe("typescript");
    expect(result.resolved_language).toBe("typescript");
    expect(result.resolved_workspace).toBeNull();
    expect(result.backend_instance_id).toBeNull();
    expect(Array.isArray(result.recovery_plan)).toBe(true);
    expect(String(result.recovery_plan?.[0]?.command || "")).toContain("switch_workspace_for_language");
    expect(result.recovery_plan?.[0]?.type).toBe("tool_call");
    expect(result.recovery_plan?.[0]?.tool).toBe("switch_workspace_for_language");
    expect(result.recovery_plan?.[0]?.args?.language).toBe("typescript");
    expect(typeof result.recovery_plan?.[0]?.args?.path).toBe("string");
    expect(typeof result.result_size).toBe("number");
    expect(typeof result.cursor_available).toBe("boolean");
    expect(typeof result.truncated).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.confidence_reason).toBe("string");
  });
});
