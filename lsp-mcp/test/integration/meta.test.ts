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
    expect(result.backend_packages.find((pkg: any) => pkg.language === "typescript")?.minimum_supported_version).toBeDefined();

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
    expect(["registry", "auto", "bundled"]).toContain(result.backend_runtime_mode);
    expect(result.backend_packages).toBeDefined();
    expect(Array.isArray(result.backend_packages)).toBe(true);
    expect(result.backend_packages.find((pkg: any) => pkg.language === "typescript")?.package_ref).toBe(
      "@treedy/typescript-lsp-mcp@latest"
    );
  });

  it("should expose package install/update strategy in check_versions", async () => {
    const result = await client.callTool("check_versions", {});
    expect(["registry", "auto", "bundled"]).toContain(result.backend_runtime_mode);
    expect(result.backend_packages).toBeDefined();
    expect(Array.isArray(result.backend_packages)).toBe(true);

    const typescriptPkg = result.backend_packages.find((pkg: any) => pkg.language === "typescript");
    expect(typescriptPkg.package_ref).toBe("@treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.install_command).toBe("npx --yes @treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.update_command).toBe("npx --yes @treedy/typescript-lsp-mcp@latest");
    expect(typescriptPkg.default_channel).toBe("latest");
    expect(typescriptPkg.minimum_supported_version).toBe("0.1.0");

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
    expect(result.backendPackageDrift.typescript.latest_status).toBeDefined();
    expect(result.backendPackageDrift.typescript.latest_next_step).toBeDefined();
    expect(result.backendPackageDrift.typescript.minimum_supported_version).toBeDefined();
    expect(result.backendPackageDrift.typescript.minimum_status).toBeDefined();
    expect(result.backendPackageDrift.typescript.next_step).toBeDefined();
    expect(result.backendVersionSummary).toBeDefined();
    expect(result.backendVersionSummary.schema_version).toBe(1);
    expect(result.backendVersionSummary.by_language.typescript).toBeDefined();
    expect(result.backendVersionSummary.counts.languages).toBeGreaterThan(0);
    expect(result.backendVersionSummary.lookup_stats.cache_ttl_ms).toBeGreaterThan(0);
    expect(["registry", "auto", "bundled"]).toContain(result.backendRuntimeMode);
    expect(result.benchmarkInsights).toBeDefined();
    expect(typeof result.benchmarkInsights.found).toBe("boolean");
    expect(typeof result.benchmarkInsights.path).toBe("string");
    expect(typeof result.benchmarkInsights.next_step).toBe("string");
    expect(result.workspaceDependencyChecks).toBeDefined();
    expect(result.workspaceDependencyChecks.language_workspace_discovery).toBeDefined();
    expect(result.workspaceDependencyChecks.language_command_chains).toBeDefined();
    if (result.backendRuntimeMode === "bundled" && result.enabledLanguages.includes("python")) {
      expect(result.workspaceDependencyChecks.python_bundled_runtime).toBeDefined();
      expect([
        "ok",
        "probe_skipped",
        "probe_failed",
        "missing_bundle",
        "missing_uv",
      ]).toContain(result.workspaceDependencyChecks.python_bundled_runtime.status);
    }
    expect(result.languageCommandChains).toBeDefined();
    expect(result.languageCommandChains.typescript).toBeDefined();
    expect(Array.isArray(result.languageCommandChains.typescript.commands)).toBe(true);
    expect(result.languageCommandChains.typescript.commands.length).toBeGreaterThan(0);
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.featureCapabilityMatrix).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript?.probe_required).toBe(true);
    expect(result.featureCapabilityMatrix.typescript?.feature_next_steps?.semantic_tokens?.command).toContain("semantic_tokens(");
    expect(typeof result.featureCapabilityMatrix.typescript?.feature_next_steps?.semantic_tokens?.expected_latency_ms?.p50).toBe("number");
    expect(Array.isArray(result.featureCapabilityMatrix.typescript?.feature_next_steps?.semantic_tokens?.failure_signatures)).toBe(true);
  });

  it("should expose doctor feature capability matrix when probing backends", async () => {
    const result = await client.callTool("doctor", { probe_backends: true });
    expect(result.featureCapabilityMatrix).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript.features).toBeDefined();
    expect(result.featureCapabilityMatrix.typescript.features.semantic_tokens).toBe("supported");
    expect(result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.status).toBe("supported");
    expect(result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.command).toContain("semantic_tokens(");
    expect(typeof result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.expected_latency_ms?.p95).toBe("number");
    expect(result.featureCapabilityMatrix.typescript.feature_next_steps.semantic_tokens.failure_signatures.length).toBeGreaterThan(0);
    expect(["supported", "not_supported"]).toContain(result.featureCapabilityMatrix.python.features.semantic_tokens);
    expect(typeof result.capability_snapshot_id).toBe("string");
    expect(["created", "reused", "none"]).toContain(result.capability_snapshot_status);
    if (result.backendRuntimeMode === "bundled" && result.enabledLanguages.includes("python")) {
      expect(result.workspaceDependencyChecks.python_bundled_runtime).toBeDefined();
      expect(result.workspaceDependencyChecks.python_bundled_runtime.probe_executed).toBe(true);
    }
  }, 15000);

  it("should reuse capability snapshot to avoid reprobe", async () => {
    const probed = await client.callTool("doctor", { probe_backends: true });
    const reused = await client.callTool("doctor", {
      capability_snapshot_id: probed.capability_snapshot_id,
      probe_backends: false,
    });
    expect(reused.capability_snapshot_id).toBe(probed.capability_snapshot_id);
    expect(reused.capability_snapshot_status).toBe("reused");
    expect(reused.featureCapabilityMatrix.typescript).toBeDefined();
  }, 15000);

  it("should expose latest lookup stats when latest-version check is enabled", async () => {
    const result = await client.callTool("doctor", { check_latest_versions: true });
    expect(result.backendVersionSummary).toBeDefined();
    expect(result.backendVersionSummary.schema_version).toBe(1);
    expect(result.backendVersionSummary.check_latest_versions).toBe(true);
    expect(result.backendVersionSummary.lookup_stats.enabled).toBe(true);
    expect(result.backendVersionSummary.lookup_stats.schema_version).toBe(1);
    expect(result.backendVersionSummary.lookup_stats.cache_ttl_ms).toBeGreaterThan(0);
    expect(typeof result.backendVersionSummary.lookup_stats.requested).toBe("number");
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

  it("should expose probe profile metadata for LLM clients", async () => {
    const allProfile = await client.callTool("lsp_probe_profile", {});
    expect(allProfile.profile_version).toBe(1);
    expect(Array.isArray(allProfile.features)).toBe(true);
    expect(allProfile.features).toContain("semantic_tokens");
    expect(allProfile.per_language).toBeDefined();
    expect(typeof allProfile.per_language.typescript[0].expected_latency_ms.p50).toBe("number");
    expect(Array.isArray(allProfile.per_language.typescript[0].failure_signatures)).toBe(true);

    const tsOnly = await client.callTool("lsp_probe_profile", { language: "typescript", feature: "moniker" });
    expect(tsOnly.language).toBe("typescript");
    expect(tsOnly.features).toEqual(["moniker"]);
    expect(tsOnly.per_language.typescript[0].feature).toBe("moniker");
  });
});
