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
    expect(result.backend_packages).toBeDefined();
    expect(Array.isArray(result.backend_packages)).toBe(true);

    const pythonBackend = result.backends.find((b: any) => b.name === "python");
    expect(pythonBackend.package).toContain("@latest");
    expect(["npx", "uvx"]).toContain(pythonBackend.resolver);

    const typescriptBackend = result.backends.find((b: any) => b.name === "typescript");
    expect(typescriptBackend.package).toBe("@treedy/typescript-lsp-mcp@latest");
    expect(typescriptBackend.resolver).toBe("npx");

    const vueBackend = result.backends.find((b: any) => b.name === "vue");
    expect(vueBackend.package).toBe("@treedy/vue-lsp-mcp@latest");
    expect(vueBackend.resolver).toBe("npx");
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
    expect(result.backend_packages).toBeDefined();
    expect(Array.isArray(result.backend_packages)).toBe(true);
    expect(result.backend_packages.find((pkg: any) => pkg.language === "typescript")?.package_ref).toBe(
      "@treedy/typescript-lsp-mcp@latest"
    );
  });

  it("should expose package install/update strategy in check_versions", async () => {
    const result = await client.callTool("check_versions", {});
    expect(result.backend_packages).toBeDefined();
    expect(Array.isArray(result.backend_packages)).toBe(true);

    const typescriptPkg = result.backend_packages.find((pkg: any) => pkg.language === "typescript");
    expect(typescriptPkg.package_ref).toBe("@treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.install_command).toBe("npx --yes @treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.update_command).toBe("npx --yes @treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.default_channel).toBe("latest");

    const vuePkg = result.backend_packages.find((pkg: any) => pkg.language === "vue");
    expect(vuePkg.package_ref).toBe("@treedy/vue-lsp-mcp@latest");
    expect(vuePkg.resolver).toBe("npx");
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
    expect(result.backendPackageDrift).toBeDefined();
    expect(result.backendPackageDrift.typescript).toBeDefined();
    expect(result.backendPackageDrift.typescript.package_ref).toBe("@treedy/typescript-lsp-mcp@latest");
    expect(result.backendPackageDrift.typescript.drift_status).toBeDefined();
    expect(result.backendPackageDrift.typescript.next_step).toBeDefined();
    expect(result.workspaceDependencyChecks).toBeDefined();
    expect(result.workspaceDependencyChecks.language_workspace_discovery).toBeDefined();
    expect(result.workspaceDependencyChecks.language_command_chains).toBeDefined();
    expect(result.languageCommandChains).toBeDefined();
    expect(result.languageCommandChains.typescript).toBeDefined();
    expect(Array.isArray(result.languageCommandChains.typescript.commands)).toBe(true);
    expect(result.languageCommandChains.typescript.commands.length).toBeGreaterThan(0);
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.featureCapabilityMatrix).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript?.probe_required).toBe(true);
    expect(result.featureCapabilityMatrix.typescript?.feature_next_steps?.semantic_tokens?.command).toContain("semantic_tokens(");
  });

  it("should expose doctor feature capability matrix when probing backends", async () => {
    const result = await client.callTool("doctor", { probe_backends: true });
    expect(result.featureCapabilityMatrix).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript.features).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript.features.semantic_tokens).toBe("supported");
    expect(result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.status).toBe("supported");
    expect(result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.command).toContain("semantic_tokens(");
    expect(["supported", "not_supported"]).toContain(result.featureCapabilityMatrix.python.features.semantic_tokens);
  }, 15000);

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
