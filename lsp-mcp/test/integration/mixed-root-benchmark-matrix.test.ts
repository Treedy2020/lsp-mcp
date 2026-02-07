import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const BENCHMARKS_ROOT = path.resolve(__dirname, "../../../benchmarks");
const PY_ROOT = path.join(BENCHMARKS_ROOT, "fastapi");
const TS_ROOT = path.join(BENCHMARKS_ROOT, "zod");
const VUE_ROOT = path.join(BENCHMARKS_ROOT, "vitesse");

describe("Mixed-Root Benchmark Matrix", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    for (const dir of [BENCHMARKS_ROOT, PY_ROOT, TS_ROOT, VUE_ROOT]) {
      if (!fs.existsSync(dir)) {
        throw new Error(`Benchmark workspace not found: ${dir}`);
      }
    }

    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "true",
      },
    });

    await client.callTool("switch_workspace", { path: BENCHMARKS_ROOT });
    const discovery = await client.callTool("discover_language_workspaces", {
      root: BENCHMARKS_ROOT,
      max_depth: 2,
      apply: true,
    });
    expect(discovery.suggestions.python).toBe(PY_ROOT);
    expect(discovery.suggestions.typescript).toBe(TS_ROOT);
    expect(discovery.suggestions.vue).toBe(VUE_ROOT);
  });

  afterAll(() => {
    client.kill();
  });

  it("should expose per-language command chains in doctor", async () => {
    const result = await client.callTool("doctor", {});
    const chains = result.languageCommandChains;

    expect(chains).toBeDefined();
    expect(chains.python.workspace).toBe(PY_ROOT);
    expect(chains.typescript.workspace).toBe(TS_ROOT);
    expect(chains.vue.workspace).toBe(VUE_ROOT);
    expect(Array.isArray(chains.python.commands)).toBe(true);
    expect(Array.isArray(chains.typescript.commands)).toBe(true);
    expect(Array.isArray(chains.vue.commands)).toBe(true);
    expect(String(chains.python.commands.join(" "))).toContain("hover(file='/abs/path/to/module.py'");
    expect(String(chains.typescript.commands.join(" "))).toContain("hover(file='/abs/path/to/file.ts'");
    expect(String(chains.vue.commands.join(" "))).toContain("hover(file='/abs/path/to/component.vue'");
  }, 120000);

  it("should run semantic tools successfully across python/typescript/vue roots", async () => {
    const tsHover = await client.callTool("hover", {
      file: "packages/zod/src/v4/core/util.ts",
      line: 218,
      column: 25,
    });
    expect(String(tsHover.contents || "")).toContain("jsonStringifyReplacer");
    expect(tsHover.resolved_language).toBe("typescript");
    expect(tsHover.resolved_workspace).toBe(TS_ROOT);

    const pyHover = await client.callTool("hover", {
      file: "fastapi/applications.py",
      line: 1336,
      column: 9,
    });
    expect(String(pyHover.contents || "")).toContain("include_router");
    expect(pyHover.resolved_language).toBe("python");
    expect(pyHover.resolved_workspace).toBe(PY_ROOT);

    const vueDef = await client.callTool("definition", {
      file: path.join(VUE_ROOT, "src/components/TheFooter.vue"),
      line: 21,
      column: 63,
    });
    expect(vueDef.code).not.toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(vueDef.error).toBeUndefined();
    expect(typeof vueDef.file).toBe("string");
    expect(vueDef.resolved_language).toBe("vue");
    expect(vueDef.resolved_workspace).toBe(VUE_ROOT);
  }, 180000);
});
