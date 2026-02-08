import { describe, it, expect } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");

async function getRuntimeMode(env: Record<string, string>) {
  const client = new McpTestClient(SERVER_PATH, {
    env: {
      LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "false",
      ...env,
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 800));
    const status = await client.callTool("status", {});
    return status.backend_runtime_mode;
  } finally {
    client.kill();
  }
}

describe("Backend Runtime Mode", () => {
  it("should default to registry mode", async () => {
    const mode = await getRuntimeMode({});
    expect(mode).toBe("registry");
  });

  it("should honor auto runtime mode", async () => {
    const mode = await getRuntimeMode({ LSP_MCP_BACKEND_RUNTIME_MODE: "auto" });
    expect(mode).toBe("auto");
  });

  it("should honor bundled runtime mode", async () => {
    const mode = await getRuntimeMode({ LSP_MCP_BACKEND_RUNTIME_MODE: "bundled" });
    expect(mode).toBe("bundled");
  });

  it("should force bundled when require bundled is set", async () => {
    const mode = await getRuntimeMode({
      LSP_MCP_BACKEND_RUNTIME_MODE: "registry",
      LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "true",
    });
    expect(mode).toBe("bundled");
  });
});
