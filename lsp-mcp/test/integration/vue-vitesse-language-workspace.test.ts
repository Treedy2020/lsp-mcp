import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { McpTestClient } from "../utils/mcp-client.js";

const SERVER_PATH = path.resolve(__dirname, "../../src/index.ts");
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../benchmarks/vitesse");
const FOOTER_FILE = path.join(WORKSPACE_ROOT, "src/components/TheFooter.vue");

describe("Vue Language Workspace", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      throw new Error(`Benchmark workspace not found: ${WORKSPACE_ROOT}`);
    }
    client = new McpTestClient(SERVER_PATH, {
      env: {
        ...process.env,
        LSP_MCP_PYTHON_ENABLED: "false",
        LSP_MCP_TYPESCRIPT_ENABLED: "false",
        LSP_MCP_VUE_ENABLED: "true",
        LSP_MCP_REQUIRE_BUNDLED_BACKENDS: "true",
      },
    });
  });

  afterAll(() => {
    client.kill();
  });

  it("should resolve vue tools with language-scoped workspace when global workspace differs", async () => {
    await client.callTool("switch_workspace", { path: os.tmpdir() });
    await client.callTool("switch_workspace_for_language", {
      language: "vue",
      path: WORKSPACE_ROOT,
    });

    const result = await client.callTool("definition", {
      file: FOOTER_FILE,
      line: 21,
      column: 63,
    });

    expect(result.code).not.toBe("VUE_SEMANTIC_DEPS_MISSING");
    expect(result.error).toBeUndefined();
    expect(typeof result.file).toBe("string");
  }, 120000);

  it("should return linked editing ranges for Vue workspace", async () => {
    const testFile = path.join(WORKSPACE_ROOT, "src/components/__lsp_linked_editing_test__.vue");
    fs.writeFileSync(
      testFile,
      [
        "<script setup lang=\"ts\">",
        "const sharedName = 'x'",
        "console.log(sharedName)",
        "</script>",
        "",
      ].join("\n")
    );

    try {
      await client.callTool("switch_workspace_for_language", {
        language: "vue",
        path: WORKSPACE_ROOT,
      });
      const result = await client.callTool("linked_editing_range", {
        file: testFile,
        line: 2,
        column: 8,
      });
      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.ranges)).toBe(true);
      expect(result.count).toBeGreaterThan(1);
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }, 120000);

  it("should return semantic tokens or strict NOT_IMPLEMENTED for Vue workspace", async () => {
    await client.callTool("switch_workspace_for_language", {
      language: "vue",
      path: WORKSPACE_ROOT,
    });
    const result = await client.callTool("semantic_tokens", {
      file: FOOTER_FILE,
    });
    if (result.error_code === "NOT_IMPLEMENTED") {
      expect(result.strict_mode).toBe(true);
      return;
    }
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.tokens)).toBe(true);
  }, 120000);

  it("should return moniker-style identity for Vue symbol", async () => {
    const testFile = path.join(WORKSPACE_ROOT, "src/components/__lsp_moniker_test__.vue");
    fs.writeFileSync(
      testFile,
      [
        "<script setup lang=\"ts\">",
        "const sharedName = 'x'",
        "console.log(sharedName)",
        "</script>",
        "",
      ].join("\n")
    );
    try {
      await client.callTool("switch_workspace_for_language", {
        language: "vue",
        path: WORKSPACE_ROOT,
      });
      const result = await client.callTool("moniker", {
        file: testFile,
        line: 3,
        column: 14,
      });
      expect(result.error).toBeUndefined();
      expect(typeof result.identifier).toBe("string");
      expect(typeof result.source_file).toBe("string");
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }, 120000);

  it("should support implementation/type_definition/prepare_rename/document_highlight", async () => {
    const testFile = path.join(WORKSPACE_ROOT, "src/components/__lsp_advanced_nav_test__.vue");
    fs.writeFileSync(
      testFile,
      [
        "<script setup lang=\"ts\">",
        "const sharedName = 'x'",
        "console.log(sharedName)",
        "</script>",
        "",
      ].join("\n")
    );
    try {
      await client.callTool("switch_workspace_for_language", { language: "vue", path: WORKSPACE_ROOT });

      const implementation = await client.callTool("implementation", {
        file: testFile,
        line: 3,
        column: 14,
      });
      if (implementation.error_code === "NOT_IMPLEMENTED") {
        expect(implementation.strict_mode).toBe(true);
      } else {
        expect(String(implementation.error || "")).not.toContain("Method not found");
      }

      const typeDefinition = await client.callTool("type_definition", {
        file: testFile,
        line: 3,
        column: 14,
      });
      if (typeDefinition.error_code === "NOT_IMPLEMENTED") {
        expect(typeDefinition.strict_mode).toBe(true);
      } else {
        expect(String(typeDefinition.error || "")).not.toContain("Method not found");
      }

      const prepareRename = await client.callTool("prepare_rename", {
        file: testFile,
        line: 3,
        column: 14,
      });
      if (prepareRename.error_code === "NOT_IMPLEMENTED") {
        expect(prepareRename.strict_mode).toBe(true);
      } else {
        expect(typeof prepareRename.canRename).toBe("boolean");
      }

      const highlight = await client.callTool("document_highlight", {
        file: testFile,
        line: 3,
        column: 14,
      });
      if (highlight.error_code === "NOT_IMPLEMENTED") {
        expect(highlight.strict_mode).toBe(true);
      } else {
        expect(Array.isArray(highlight.highlights)).toBe(true);
      }
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }, 120000);

  it("should support selection/folding/link/call hierarchy/code_action flow", async () => {
    const testFile = path.join(WORKSPACE_ROOT, "src/components/__lsp_advanced_flow_test__.vue");
    fs.writeFileSync(
      testFile,
      [
        "<script setup lang=\"ts\">",
        "import { computed } from 'vue'",
        "const sharedName = 'x'",
        "const upper = computed(() => sharedName.toUpperCase())",
        "console.log(upper.value)",
        "</script>",
        "",
      ].join("\n")
    );
    try {
      await client.callTool("switch_workspace_for_language", { language: "vue", path: WORKSPACE_ROOT });

      const selection = await client.callTool("selection_range", {
        file: testFile,
        line: 4,
        column: 33,
      });
      if (selection.error_code === "NOT_IMPLEMENTED") {
        expect(selection.strict_mode).toBe(true);
      } else {
        expect(Array.isArray(selection.ranges)).toBe(true);
      }

      const folding = await client.callTool("folding_range", {
        file: testFile,
      });
      if (folding.error_code === "NOT_IMPLEMENTED") {
        expect(folding.strict_mode).toBe(true);
      } else {
        expect(Array.isArray(folding.ranges)).toBe(true);
      }

      const links = await client.callTool("document_link", {
        file: testFile,
      });
      if (links.error_code === "NOT_IMPLEMENTED") {
        expect(links.strict_mode).toBe(true);
      } else {
        expect(Array.isArray(links.links)).toBe(true);
      }

      const calls = await client.callTool("call_hierarchy", {
        file: testFile,
        line: 4,
        column: 33,
        direction: "both",
      });
      if (calls.error_code === "NOT_IMPLEMENTED") {
        expect(calls.strict_mode).toBe(true);
      } else {
        expect(String(calls.error || "")).not.toContain("Method not found");
        if (!calls.error) {
          expect(calls.direction).toBe("both");
        }
      }

      const actions = await client.callTool("code_action", {
        file: testFile,
        line: 2,
        column: 1,
      });
      if (actions.error_code === "NOT_IMPLEMENTED") {
        expect(actions.strict_mode).toBe(true);
      } else {
        expect(Array.isArray(actions.actions)).toBe(true);
        if (actions.actions.length > 0) {
          const run = await client.callTool("run_code_action", {
            file: testFile,
            line: 2,
            column: 1,
            title: actions.actions[0].title,
          });
          if (run.error_code === "NOT_IMPLEMENTED") {
            expect(run.strict_mode).toBe(true);
          } else {
            expect(run.success || run.error).toBeDefined();
          }
        }
      }
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }, 120000);
});
