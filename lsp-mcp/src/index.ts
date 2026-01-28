/**
 * Unified LSP MCP Server
 *
 * Aggregates multiple language-specific LSP backends into a single MCP server.
 * Supports Python (via python-lsp-mcp or pyright-mcp) and TypeScript backends.
 *
 * Tools are dynamically loaded from backends on-demand:
 * - Use list_backends to see available backends
 * - Use start_backend to install and start a backend
 * - Once started, tools are available as python_hover, typescript_definition, etc.
 *
 * Backends are lazy-loaded - they're only installed and started when you call start_backend.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type PythonProvider, type Language } from "./config.js";
import { BackendManager } from "./backend-manager.js";
import {
  status as statusTool,
  checkVersions as checkVersionsTool,
  switchPythonBackend,
  switchPythonBackendSchema,
  listBackends as listBackendsTool,
  startBackend as startBackendTool,
  startBackendSchema,
  updateBackend as updateBackendTool,
  updateBackendSchema,
} from "./tools/meta.js";
import { registerPrompts } from "./prompts.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Load configuration
const config = loadConfig();

// Create backend manager
const backendManager = new BackendManager(config);

// Track which backends have been started (to avoid duplicate tool registration)
const startedBackends = new Set<Language>();

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
// Dynamic Tool Registration
// ============================================================================

/**
 * Convert a backend tool schema to Zod schema for MCP registration.
 * The backend returns JSON Schema format, we need to convert to Zod.
 */
function jsonSchemaToZod(schema: any): Record<string, z.ZodTypeAny> {
  const result: Record<string, z.ZodTypeAny> = {};

  if (!schema || !schema.properties) {
    return result;
  }

  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    let zodType: z.ZodTypeAny;

    switch (prop.type) {
      case "string":
        zodType = z.string();
        if (prop.enum) {
          zodType = z.enum(prop.enum as [string, ...string[]]);
        }
        break;
      case "number":
      case "integer":
        zodType = z.number();
        if (prop.type === "integer") {
          zodType = (zodType as z.ZodNumber).int();
        }
        if (prop.exclusiveMinimum !== undefined) {
          zodType = (zodType as z.ZodNumber).gt(prop.exclusiveMinimum);
        }
        if (prop.minimum !== undefined) {
          zodType = (zodType as z.ZodNumber).gte(prop.minimum);
        }
        if (prop.maximum !== undefined) {
          zodType = (zodType as z.ZodNumber).lte(prop.maximum);
        }
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "array":
        if (prop.items?.type === "string") {
          zodType = z.array(z.string());
        } else {
          zodType = z.array(z.any());
        }
        break;
      case "object":
        zodType = z.record(z.any());
        break;
      default:
        zodType = z.any();
    }

    // Add description
    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    // Add default
    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default);
    }

    // Make optional if not required
    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    result[key] = zodType;
  }

  return result;
}

/**
 * Register tools from a backend with namespace prefix.
 * Uses underscore separator for MCP compliance (e.g., python_hover instead of python/hover)
 */
function registerBackendTools(language: Language, tools: Tool[]): number {
  let count = 0;
  for (const tool of tools) {
    const namespacedName = `${language}_${tool.name}`;

    // Convert JSON Schema to Zod schema
    const zodSchema = jsonSchemaToZod(tool.inputSchema);

    server.registerTool(
      namespacedName,
      {
        description: tool.description || `${language} ${tool.name} tool`,
        inputSchema: zodSchema,
      },
      async (args) => backendManager.callTool(language, tool.name, args as Record<string, unknown>)
    );

    console.error(`[lsp-mcp] Registered ${namespacedName}`);
    count++;
  }

  // Notify client that tools have changed
  server.sendToolListChanged();

  return count;
}

/**
 * Start a backend and register its tools.
 * Returns the number of tools registered.
 */
async function startAndRegisterBackend(language: Language): Promise<number> {
  // Check if already started
  if (startedBackends.has(language)) {
    const status = backendManager.getStatus()[language];
    console.error(`[lsp-mcp] ${language} backend already started (${status?.tools} tools)`);
    return status?.tools || 0;
  }

  console.error(`[lsp-mcp] Starting ${language} backend...`);

  try {
    const tools = await backendManager.getTools(language);
    const count = registerBackendTools(language, tools);
    startedBackends.add(language);
    console.error(`[lsp-mcp] ${language}: ${count} tools registered`);
    return count;
  } catch (error) {
    console.error(`[lsp-mcp] Failed to start ${language} backend:`, error);
    throw error;
  }
}

/**
 * Update a backend to the latest version.
 * Restarts the backend and re-registers tools if already started.
 */
async function updateAndRestartBackend(language: Language): Promise<{ oldVersion: string | null; newVersion: string | null }> {
  console.error(`[lsp-mcp] Updating ${language} backend...`);

  // Restart the backend to get the latest version
  const result = await backendManager.restartBackend(language);

  // If this backend was previously started, re-register its tools
  // (tools are already registered in the server, they will route to the new backend)
  if (startedBackends.has(language)) {
    console.error(`[lsp-mcp] ${language} backend updated, tools still available`);
  } else {
    // If not started before, now mark it as started and register tools
    const tools = await backendManager.getTools(language);
    registerBackendTools(language, tools);
    startedBackends.add(language);
    console.error(`[lsp-mcp] ${language} backend updated and ${tools.length} tools registered`);
  }

  return result;
}

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

server.registerTool(
  "list_backends",
  {
    description: "List available backends and their status. Shows which backends are installed, running, and how many tools they provide.",
  },
  async () => listBackendsTool(backendManager, config)
);

server.registerTool(
  "start_backend",
  {
    description: "Start a backend and register its tools. This will download and install the backend if needed, then make its tools available.",
    inputSchema: startBackendSchema,
  },
  async ({ language }) => startBackendTool(
    language as "python" | "typescript",
    backendManager,
    config,
    startAndRegisterBackend
  )
);

server.registerTool(
  "update_backend",
  {
    description: "Update a backend to the latest version. This will restart the backend with the newest version available.",
    inputSchema: updateBackendSchema,
  },
  async ({ language }) => updateBackendTool(
    language as "python" | "typescript",
    backendManager,
    config,
    updateAndRestartBackend
  )
);

// ============================================================================
// Pre-registered Tools (for on-demand loading)
// ============================================================================

/**
 * Known tools for each backend with their schemas.
 * These are pre-registered so they appear in ToolSearch,
 * but the backend is only started when the tool is first called.
 */
const KNOWN_TOOLS: Record<Language, Array<{
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}>> = {
  python: [
    { name: "hover", description: "Get documentation for the symbol at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
    { name: "definition", description: "Get the definition location for the symbol at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
    { name: "references", description: "Find all references to the symbol at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
    { name: "completions", description: "Get code completion suggestions at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
    { name: "symbols", description: "Get symbols from a Python file", schema: { file: z.string(), query: z.string().optional() } },
    { name: "diagnostics", description: "Get type errors and warnings for a Python file or directory", schema: { path: z.string() } },
    { name: "rename", description: "Rename the symbol at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int(), new_name: z.string() } },
    { name: "signature_help", description: "Get function signature information at the given position", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
    { name: "update_document", description: "Update file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
    { name: "search", description: "Search for a regex pattern in files using ripgrep", schema: { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() } },
    { name: "status", description: "Get the status of the Python MCP server", schema: {} },
  ],
  typescript: [
    { name: "hover", description: "Get type information and documentation at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "definition", description: "Go to definition of a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "references", description: "Find all references to a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "completions", description: "Get code completion suggestions at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), limit: z.number().int().positive().default(20).optional() } },
    { name: "signature_help", description: "Get function signature help at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "symbols", description: "Extract symbols (classes, functions, methods, variables) from a file", schema: { file: z.string(), query: z.string().optional() } },
    { name: "diagnostics", description: "Get type errors and warnings for a TypeScript/JavaScript file", schema: { path: z.string() } },
    { name: "rename", description: "Preview renaming a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), newName: z.string() } },
    { name: "update_document", description: "Update file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
    { name: "status", description: "Check TypeScript environment status for a project", schema: { file: z.string() } },
    { name: "search", description: "Search for a pattern in files using ripgrep", schema: { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() } },
    { name: "move", description: "Move a function, class, or variable to a new file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), destination: z.string().optional(), preview: z.boolean().default(false).optional() } },
    { name: "function_signature", description: "Get the current signature of a function at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "available_refactors", description: "Get available refactoring actions at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "apply_refactor", description: "Apply a specific refactoring action at a position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), refactorName: z.string(), actionName: z.string(), preview: z.boolean().default(false).optional() } },
  ],
  vue: [
    { name: "hover", description: "Get type information and documentation at a specific position in a Vue SFC file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "definition", description: "Go to definition of a symbol at a specific position in a Vue SFC file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "references", description: "Find all references to a symbol at a specific position in a Vue SFC file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "completions", description: "Get code completion suggestions at a specific position in a Vue SFC file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), limit: z.number().int().positive().default(20).optional() } },
    { name: "signature_help", description: "Get function signature help at a specific position in a Vue SFC file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "diagnostics", description: "Get type errors and warnings for Vue SFC files", schema: { path: z.string() } },
    { name: "update_document", description: "Update Vue file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
    { name: "symbols", description: "Extract symbols (variables, functions, components) from a Vue SFC file", schema: { file: z.string(), query: z.string().optional() } },
    { name: "rename", description: "Preview renaming a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), newName: z.string() } },
    { name: "search", description: "Search for a pattern in Vue files using ripgrep", schema: { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() } },
    { name: "status", description: "Check Vue Language Server status for a project", schema: { file: z.string() } },
  ],
};

/**
 * Pre-register all known tools for enabled backends.
 * Each tool auto-starts its backend on first call.
 */
function preRegisterKnownTools(): void {
  const languages: Language[] = [];
  if (config.python.enabled) languages.push("python");
  if (config.typescript.enabled) languages.push("typescript");
  if (config.vue.enabled) languages.push("vue");

  let totalCount = 0;

  for (const language of languages) {
    const tools = KNOWN_TOOLS[language];
    if (!tools) continue;

    for (const tool of tools) {
      const namespacedName = `${language}_${tool.name}`;

      server.registerTool(
        namespacedName,
        {
          description: tool.description,
          inputSchema: tool.schema,
        },
        async (args) => {
          // Auto-start backend if not started
          if (!startedBackends.has(language)) {
            console.error(`[lsp-mcp] Auto-starting ${language} backend for ${tool.name}...`);
            try {
              await backendManager.getBackend(language);
              startedBackends.add(language);
              console.error(`[lsp-mcp] ${language} backend started`);
            } catch (error) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ error: `Failed to start ${language} backend: ${error}` }) }],
              };
            }
          }

          // Call the actual backend tool
          return backendManager.callTool(language, tool.name, args as Record<string, unknown>);
        }
      );

      totalCount++;
    }

    console.error(`[lsp-mcp] Pre-registered ${tools.length} ${language} tools`);
  }

  console.error(`[lsp-mcp] Total: ${totalCount} tools pre-registered (backends start on first use)`);
}

// Pre-register all known tools at module load time
preRegisterKnownTools();

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
  console.error(`  Version: ${packageJson.version}`);
  console.error("  Python:", config.python.enabled ? `enabled (${config.python.provider})` : "disabled");
  console.error("  TypeScript:", config.typescript.enabled ? "enabled" : "disabled");
  console.error("  Vue:", config.vue.enabled ? "enabled" : "disabled");
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Eagerly start all enabled backends if configured
  if (config.eagerStart) {
    console.error("Eager start enabled - starting all backends now...");
    const languages: Language[] = [];
    if (config.python.enabled) languages.push("python");
    if (config.typescript.enabled) languages.push("typescript");
    if (config.vue.enabled) languages.push("vue");

    // Start backends in parallel
    await Promise.allSettled(
      languages.map(async (lang) => {
        try {
          await backendManager.getBackend(lang);
          startedBackends.add(lang);
          console.error(`  ${lang}: backend started`);
        } catch (error) {
          console.error(`  ${lang}: failed to start - ${error}`);
        }
      })
    );
  } else {
    console.error("Tools are pre-registered. Backends start automatically on first use.");
  }

  console.error("");
  console.error("Ready");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
