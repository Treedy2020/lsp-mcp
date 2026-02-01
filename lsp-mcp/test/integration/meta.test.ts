import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");

describe("Meta Tools", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    // Wait for init
    await new Promise(r => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
  });

  it("should list backends", async () => {
    const result = await client.callTool("list_backends", {});
    expect(result.backends).toBeDefined();
    expect(result.backends.find((b: any) => b.name === "python")).toBeDefined();
    expect(result.backends.find((b: any) => b.name === "typescript")).toBeDefined();
  });

  it("should show status", async () => {
    const result = await client.callTool("status", {});
    expect(result.server).toBe("lsp-mcp");
    expect(result.version).toBeDefined();
    expect(result.config).toBeDefined();
  });
});
