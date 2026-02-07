import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");

describe("Prompt Registration", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient(SERVER_PATH);
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    client.kill();
  });

  it("should list all expected prompts", async () => {
    const result = await client.request("prompts/list", {});
    const names = (result.prompts || []).map((p: { name: string }) => p.name).sort();

    expect(names).toEqual([
      "code-analysis",
      "code-navigation",
      "debug-file",
      "explore-project",
      "lsp-quick-start",
      "lsp-rules",
      "refactoring",
    ]);
  });

  it("should resolve argument-based prompts with runtime values", async () => {
    const result = await client.request("prompts/get", {
      name: "explore-project",
      arguments: { path: "/tmp/demo-repo" },
    });

    const text = result.messages?.[0]?.content?.text ?? "";
    expect(text).toContain("'/tmp/demo-repo'");
    expect(text).toContain("project_structure");
    expect(text).toContain("summarize_file");
  });

  it("should include mixed-language workspace guidance in quick-start prompt", async () => {
    const result = await client.request("prompts/get", {
      name: "lsp-quick-start",
    });

    const text = result.messages?.[0]?.content?.text ?? "";
    expect(text).toContain("switch_workspace_for_language");
    expect(text).toContain("discover_language_workspaces");
    expect(text).toContain("doctor");
    expect(text).toContain("resolved_workspace");
  });

  it("should include strict semantic workspace workflow in rules prompt", async () => {
    const result = await client.request("prompts/get", {
      name: "lsp-rules",
    });

    const text = result.messages?.[0]?.content?.text ?? "";
    expect(text).toContain("switch_workspace_for_language");
    expect(text).toContain("discover_language_workspaces");
    expect(text).toContain("semantic tools");
  });
});
