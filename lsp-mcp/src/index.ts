/**
 * Unified LSP MCP Server
 *
 * Aggregates multiple language-specific LSP backends into a single MCP server.
 * Supports Python (via python-lsp-mcp or pyright-mcp) and TypeScript backends.
 *
 * Tools are namespaced by language:
 * - python/hover, python/definition, etc.
 * - typescript/hover, typescript/definition, etc.
 *
 * Language can also be auto-inferred from file extensions in tool arguments.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";

import { loadConfig, type PythonProvider } from "./config.js";
import { BackendManager } from "./backend-manager.js";
import { pythonToolDescriptions } from "./backends/python.js";
import { typescriptToolDescriptions } from "./backends/typescript.js";
import {
  positionArgs,
  searchArgs,
  diagnosticsArgs,
  renameArgs,
  symbolsArgs,
  updateDocumentArgs,
  completionsArgs,
} from "./tools/schemas.js";
import {
  status as statusTool,
  checkVersions as checkVersionsTool,
  switchPythonBackend,
  switchPythonBackendSchema,
} from "./tools/meta.js";
import { registerPrompts } from "./prompts.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Load configuration
const config = loadConfig();

// Create backend manager
const backendManager = new BackendManager(config);

// Create MCP server
const server = new McpServer({
  name: "lsp-mcp",
  version: packageJson.version,
});

// ============================================================================
// Prompts (Skills)
// ============================================================================

registerPrompts(server);

// ============================================================================
// Meta Tools
// ============================================================================

server.registerTool(
  "status",
  { description: "Get status of all LSP backends and server configuration" },
  async () => statusTool(backendManager, config)
);

server.registerTool(
  "check_versions",
  { description: "Check versions of all backends and server. Shows installed versions and how to check for updates." },
  async () => checkVersionsTool(backendManager, config)
);

server.registerTool(
  "switch_python_backend",
  {
    description: "Switch the Python backend provider (requires restart)",
    inputSchema: switchPythonBackendSchema,
  },
  async ({ provider }) => switchPythonBackend(provider as PythonProvider)
);

// ============================================================================
// Python Tools (namespaced as python/*)
// ============================================================================

if (config.python.enabled) {
  const backendOption = z.enum(["rope", "pyright"]).optional().describe("Backend to use (rope/pyright)");

  // python/hover
  server.registerTool("python/hover", {
    description: pythonToolDescriptions.hover,
    inputSchema: { ...positionArgs, backend: backendOption },
  }, async (args) => backendManager.callTool("python", "hover", args));

  // python/definition
  server.registerTool("python/definition", {
    description: pythonToolDescriptions.definition,
    inputSchema: { ...positionArgs, backend: backendOption },
  }, async (args) => backendManager.callTool("python", "definition", args));

  // python/references
  server.registerTool("python/references", {
    description: pythonToolDescriptions.references,
    inputSchema: { ...positionArgs, backend: backendOption },
  }, async (args) => backendManager.callTool("python", "references", args));

  // python/completions
  server.registerTool("python/completions", {
    description: pythonToolDescriptions.completions,
    inputSchema: { ...completionsArgs, backend: backendOption },
  }, async (args) => backendManager.callTool("python", "completions", args));

  // python/diagnostics
  server.registerTool("python/diagnostics", {
    description: pythonToolDescriptions.diagnostics,
    inputSchema: diagnosticsArgs,
  }, async (args) => backendManager.callTool("python", "diagnostics", args));

  // python/symbols
  server.registerTool("python/symbols", {
    description: pythonToolDescriptions.symbols,
    inputSchema: { ...symbolsArgs, backend: backendOption },
  }, async (args) => backendManager.callTool("python", "symbols", args));

  // python/rename
  server.registerTool("python/rename", {
    description: pythonToolDescriptions.rename,
    inputSchema: { ...positionArgs, new_name: z.string().describe("New name for the symbol") },
  }, async (args) => backendManager.callTool("python", "rename", args));

  // python/search
  server.registerTool("python/search", {
    description: pythonToolDescriptions.search,
    inputSchema: searchArgs,
  }, async (args) => backendManager.callTool("python", "search", args));

  // python/signature_help
  server.registerTool("python/signature_help", {
    description: pythonToolDescriptions.signature_help,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("python", "signature_help", args));

  // python/update_document
  server.registerTool("python/update_document", {
    description: pythonToolDescriptions.update_document,
    inputSchema: updateDocumentArgs,
  }, async (args) => backendManager.callTool("python", "update_document", args));

  // python/status
  server.registerTool("python/status", {
    description: pythonToolDescriptions.status,
  }, async () => backendManager.callTool("python", "status", {}));

  // Python-only tools
  // python/move
  server.registerTool("python/move", {
    description: pythonToolDescriptions.move,
    inputSchema: {
      ...positionArgs,
      destination: z.string().describe('Destination module path (e.g., "mypackage.utils")'),
      preview: z.boolean().default(false).describe("If true, only show what would change"),
    },
  }, async (args) => backendManager.callTool("python", "move", args));

  // python/change_signature
  server.registerTool("python/change_signature", {
    description: pythonToolDescriptions.change_signature,
    inputSchema: {
      ...positionArgs,
      new_params: z.array(z.string()).optional().describe("New parameter order"),
      add_param: z.string().optional().describe("Name of parameter to add"),
      add_param_default: z.string().optional().describe("Default value for added parameter"),
      add_param_index: z.number().int().optional().describe("Index where to insert new param"),
      remove_param: z.string().optional().describe("Name of parameter to remove"),
      preview: z.boolean().default(false).describe("If true, only show what would change"),
    },
  }, async (args) => backendManager.callTool("python", "change_signature", args));

  // python/function_signature
  server.registerTool("python/function_signature", {
    description: pythonToolDescriptions.function_signature,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("python", "function_signature", args));

  // python/set_backend
  server.registerTool("python/set_backend", {
    description: pythonToolDescriptions.set_backend,
    inputSchema: {
      backend: z.enum(["rope", "pyright"]).describe("The backend to use"),
      tool: z.string().optional().describe("Optional tool name to set backend for"),
    },
  }, async (args) => backendManager.callTool("python", "set_backend", args));

  // python/set_python_path
  server.registerTool("python/set_python_path", {
    description: pythonToolDescriptions.set_python_path,
    inputSchema: {
      python_path: z.string().describe("Absolute path to the Python interpreter"),
      workspace: z.string().optional().describe("Optional workspace to set the path for"),
    },
  }, async (args) => backendManager.callTool("python", "set_python_path", args));
}

// ============================================================================
// TypeScript Tools (namespaced as typescript/*)
// ============================================================================

if (config.typescript.enabled) {
  // typescript/hover
  server.registerTool("typescript/hover", {
    description: typescriptToolDescriptions.hover,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("typescript", "hover", args));

  // typescript/definition
  server.registerTool("typescript/definition", {
    description: typescriptToolDescriptions.definition,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("typescript", "definition", args));

  // typescript/references
  server.registerTool("typescript/references", {
    description: typescriptToolDescriptions.references,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("typescript", "references", args));

  // typescript/completions
  server.registerTool("typescript/completions", {
    description: typescriptToolDescriptions.completions,
    inputSchema: completionsArgs,
  }, async (args) => backendManager.callTool("typescript", "completions", args));

  // typescript/diagnostics
  server.registerTool("typescript/diagnostics", {
    description: typescriptToolDescriptions.diagnostics,
    inputSchema: diagnosticsArgs,
  }, async (args) => backendManager.callTool("typescript", "diagnostics", args));

  // typescript/symbols
  server.registerTool("typescript/symbols", {
    description: typescriptToolDescriptions.symbols,
    inputSchema: symbolsArgs,
  }, async (args) => backendManager.callTool("typescript", "symbols", args));

  // typescript/rename
  server.registerTool("typescript/rename", {
    description: typescriptToolDescriptions.rename,
    inputSchema: renameArgs,
  }, async (args) => backendManager.callTool("typescript", "rename", args));

  // typescript/search
  server.registerTool("typescript/search", {
    description: typescriptToolDescriptions.search,
    inputSchema: searchArgs,
  }, async (args) => backendManager.callTool("typescript", "search", args));

  // typescript/signature_help
  server.registerTool("typescript/signature_help", {
    description: typescriptToolDescriptions.signature_help,
    inputSchema: positionArgs,
  }, async (args) => backendManager.callTool("typescript", "signature_help", args));

  // typescript/update_document
  server.registerTool("typescript/update_document", {
    description: typescriptToolDescriptions.update_document,
    inputSchema: updateDocumentArgs,
  }, async (args) => backendManager.callTool("typescript", "update_document", args));

  // typescript/status
  server.registerTool("typescript/status", {
    description: typescriptToolDescriptions.status,
    inputSchema: {
      file: z.string().describe("A TypeScript/JavaScript file to check project status for"),
    },
  }, async (args) => backendManager.callTool("typescript", "status", args));

  // typescript/move
  server.registerTool("typescript/move", {
    description: "Move a function, class, or variable to a new file",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      line: z.number().int().positive().describe("Line number (1-based)"),
      column: z.number().int().positive().describe("Column number (1-based)"),
      destination: z.string().optional().describe("Destination file path (optional)"),
      preview: z.boolean().default(false).describe("If true, only show what would change"),
    },
  }, async (args) => backendManager.callTool("typescript", "move", args));

  // typescript/function_signature
  server.registerTool("typescript/function_signature", {
    description: "Get the current signature of a function at a specific position",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      line: z.number().int().positive().describe("Line number (1-based)"),
      column: z.number().int().positive().describe("Column number (1-based)"),
    },
  }, async (args) => backendManager.callTool("typescript", "function_signature", args));

  // typescript/available_refactors
  server.registerTool("typescript/available_refactors", {
    description: "Get available refactoring actions at a specific position",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      line: z.number().int().positive().describe("Line number (1-based)"),
      column: z.number().int().positive().describe("Column number (1-based)"),
    },
  }, async (args) => backendManager.callTool("typescript", "available_refactors", args));

  // typescript/apply_refactor
  server.registerTool("typescript/apply_refactor", {
    description: "Apply a specific refactoring action at a position",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      line: z.number().int().positive().describe("Line number (1-based)"),
      column: z.number().int().positive().describe("Column number (1-based)"),
      refactorName: z.string().describe("Name of the refactoring"),
      actionName: z.string().describe("Name of the action"),
      preview: z.boolean().default(false).describe("If true, only show what would change"),
    },
  }, async (args) => backendManager.callTool("typescript", "apply_refactor", args));
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function gracefulShutdown(signal: string): Promise<void> {
  console.error(`\n[lsp-mcp] Received ${signal}, shutting down gracefully...`);

  try {
    await backendManager.shutdown();
    await server.close();
    console.error("[lsp-mcp] Shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("[lsp-mcp] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.error("LSP MCP Server - Unified Multi-Language Code Intelligence");
  console.error("  Python:", config.python.enabled ? `enabled (${config.python.provider})` : "disabled");
  console.error("  TypeScript:", config.typescript.enabled ? "enabled" : "disabled");
  console.error("");
  console.error("Tools are namespaced: python/hover, typescript/definition, etc.");
  console.error("Prompts available: code-navigation, refactoring, code-analysis, lsp-rules, lsp-quick-start");
  console.error("Backends start lazily on first tool call.");
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Ready");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
