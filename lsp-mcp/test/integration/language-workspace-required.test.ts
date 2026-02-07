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
    expect(result.required_workspace_scope).toBe("language");
    expect(result.language).toBe("typescript");
    expect(result.resolved_workspace).toBeNull();
    expect(result.backend_instance_id).toBeNull();
  });
});
