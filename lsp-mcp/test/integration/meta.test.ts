import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
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
    expect(result.workspaces).toBeDefined();
    expect(result.workspaces.global).toBeDefined();
    expect(result.workspaces.per_language).toBeDefined();
    expect(result.workspaces.overrides).toBeDefined();
    expect(result.workspaces.resolved).toBeDefined();
  });

  it("should expose workspace overrides and resolved values", async () => {
    await client.callTool("switch_workspace", { path: os.tmpdir() });
    await client.callTool("switch_workspace_for_language", { language: "vue", path: "/tmp" });
    const result = await client.callTool("status", {});

    expect(result.workspaces.global).toBe(os.tmpdir());
    expect(result.workspaces.overrides.vue).toBe("/tmp");
    expect(result.workspaces.resolved.vue).toBe("/tmp");
    expect(result.workspaces.resolved.typescript).toBeNull();
  });

  it("should expose legacy namespaced unified aliases", async () => {
    const result = await client.request("tools/list", {});
    const names = (result.tools || []).map((t: { name: string }) => t.name);

    expect(names).toContain("python_hover");
    expect(names).toContain("typescript_definition");
    expect(names).toContain("expand_result");
  });

  it("should provide doctor diagnostics", async () => {
    const result = await client.callTool("doctor", {});
    expect(result.checks).toBeDefined();
    expect(result.enabledLanguages).toBeDefined();
    expect(result.workspaceDependencyChecks).toBeDefined();
    expect(result.workspaceDependencyChecks.language_workspace_discovery).toBeDefined();
    expect(result.workspaceDependencyChecks.language_command_chains).toBeDefined();
    expect(result.languageCommandChains).toBeDefined();
    expect(result.languageCommandChains.typescript).toBeDefined();
    expect(Array.isArray(result.languageCommandChains.typescript.commands)).toBe(true);
    expect(result.languageCommandChains.typescript.commands.length).toBeGreaterThan(0);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  it("should support doctor pagination via expand_result", async () => {
    const first = await client.callTool("doctor", { page_size: 1 });
    expect(first.page).toBeDefined();
    expect(first.page.shown).toBe(1);
    expect(first.next?.tool).toBe("expand_result");
    expect(first.next?.arguments?.cursor).toBeDefined();

    const second = await client.callTool("expand_result", {
      cursor: first.next.arguments.cursor,
      page_size: 1,
    });
    expect(second.tool).toBe("doctor");
    expect(second.page.offset).toBe(1);
    expect(Array.isArray(second.items)).toBe(true);
  });
});
