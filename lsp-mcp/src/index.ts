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

import { loadConfig, inferLanguageFromPath, type PythonProvider, type Language } from "./config.js";
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
// Track registered tool names to avoid duplicate registration
const registeredTools = new Set<string>();
// Global active workspace path
let activeWorkspacePath: string | null = null;

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
// Dynamic Tool Registration Helpers
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
    let zodType: z.ZodTypeAny = schemaToZod(prop);

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

function schemaToZod(schema: any): z.ZodTypeAny {
  if (!schema) return z.any();

  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf) as any[];
    const mapped = variants.map((variant) => schemaToZod(variant));
    if (mapped.length === 1) return mapped[0];
    if (mapped.length > 1) return z.union(mapped as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return z.any();
  }

  if (schema.allOf) {
    const variants = schema.allOf as any[];
    if (variants.length === 0) return z.any();
    return variants.map((variant) => schemaToZod(variant)).reduce((acc, next) => z.intersection(acc, next));
  }

  if (schema.enum && schema.type === "string") {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  switch (schema.type) {
    case "string": {
      let zodType: z.ZodTypeAny = z.string();
      if (schema.minLength !== undefined) zodType = (zodType as z.ZodString).min(schema.minLength);
      if (schema.maxLength !== undefined) zodType = (zodType as z.ZodString).max(schema.maxLength);
      if (schema.pattern) {
        try {
          zodType = (zodType as z.ZodString).regex(new RegExp(schema.pattern));
        } catch {
          // Ignore invalid regex patterns.
        }
      }
      return zodType;
    }
    case "number":
    case "integer": {
      let zodType: z.ZodTypeAny = z.number();
      if (schema.type === "integer") {
        zodType = (zodType as z.ZodNumber).int();
      }
      if (schema.exclusiveMinimum !== undefined) {
        zodType = (zodType as z.ZodNumber).gt(schema.exclusiveMinimum);
      }
      if (schema.minimum !== undefined) {
        zodType = (zodType as z.ZodNumber).gte(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        zodType = (zodType as z.ZodNumber).lte(schema.maximum);
      }
      return zodType;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schemaToZod(schema.items ?? {}));
    case "object": {
      if (schema.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required = new Set(schema.required || []);
        for (const [key, prop] of Object.entries<any>(schema.properties)) {
          let propSchema = schemaToZod(prop);
          if (prop.description) {
            propSchema = propSchema.describe(prop.description);
          }
          if (prop.default !== undefined) {
            propSchema = propSchema.default(prop.default);
          }
          if (!required.has(key)) {
            propSchema = propSchema.optional();
          }
          shape[key] = propSchema;
        }
        return z.object(shape).passthrough();
      }
      return z.record(z.any());
    }
    default:
      return z.any();
  }
}

/**
 * Start a backend and register its tools.
 * Returns the number of tools registered.
 */
async function startAndRegisterBackend(language: Language): Promise<number> {
  // Check if already started
  if (startedBackends.has(language)) {
    const status = backendManager.getStatus()[language];
    console.error(`[lsp-mcp] ${language} backend already started (${status?.tools} tools)`)
    return status?.tools || 0;
  }

  console.error(`[lsp-mcp] Starting ${language} backend...`);

  try {
    // Just start the backend, tools are already registered via unified routing
    await backendManager.getBackend(language);
    startedBackends.add(language);
    console.error(`[lsp-mcp] ${language} backend started`);
    return 0; // We don't register new tools dynamically anymore
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
  startedBackends.add(language);
  
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
  "reload_config",
  { description: "Reload configuration from environment variables. Useful for changing settings without restarting the server." },
  async () => {
    const newConfig = loadConfig();
    backendManager.updateConfig(newConfig);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, message: "Configuration reloaded", config: newConfig }) }],
    };
  }
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
    language as "python" | "typescript" | "vue",
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
    language as "python" | "typescript" | "vue",
    backendManager,
    config,
    updateAndRestartBackend
  )
);

// ============================================================================ 
// Unified Tool Routing
// ============================================================================ 

/**
 * Standard LSP tools that are unified across all languages.
 * Routing is done automatically based on the 'file' or 'path' argument.
 */
const UNIFIED_TOOLS: Array<{ 
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}> = [
  { name: "hover", description: "Get type information and documentation at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "definition", description: "Go to definition of a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "references", description: "Find all references to a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "completions", description: "Get code completion suggestions at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), limit: z.number().int().positive().default(20).optional() } },
  { name: "signature_help", description: "Get function signature help at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "symbols", description: "Extract symbols (classes, functions, methods, variables) from a file", schema: { file: z.string(), query: z.string().optional() } },
  { name: "diagnostics", description: "Get type errors and warnings for a file or directory", schema: { path: z.string() } },
  { name: "rename", description: "Preview renaming a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), newName: z.string() } },
  { name: "update_document", description: "Update file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
  { name: "search", description: "Search for a pattern in files using ripgrep. Uses active workspace if path is omitted.", schema: { pattern: z.string(), path: z.string().optional(), glob: z.string().optional() } },
];

/**
 * Language-specific tools that are not part of the unified set.
 * These will be registered with a prefix (e.g., python_move).
 */
const LANGUAGE_SPECIFIC_TOOLS: Record<Language, Array<{ 
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}>> = {
  python: [
    { name: "move", description: "Move a function or class to another module", schema: { file: z.string(), line: z.number().int(), column: z.number().int(), destination: z.string() } },
    { name: "change_signature", description: "Change the signature of a function", schema: { file: z.string(), line: z.number().int(), column: z.number().int(), new_params: z.array(z.string()).optional() } },
    { name: "function_signature", description: "Get current signature of a function", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
  ],
  typescript: [
    { name: "move", description: "Move a function, class, or variable to a new file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), destination: z.string().optional(), preview: z.boolean().default(false).optional() } },
    { name: "function_signature", description: "Get current signature of a function", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "available_refactors", description: "Get available refactoring actions", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
    { name: "apply_refactor", description: "Apply a specific refactoring action", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), refactorName: z.string(), actionName: z.string(), preview: z.boolean().default(false).optional() } },
  ],
  vue: [],
};

// ============================================================================ 
// Global Workspace Tool
// ============================================================================ 

server.registerTool(
  "switch_workspace",
  {
    description: "Switch the active workspace for ALL backends simultaneously. This clears caches and refocuses code intelligence on the new project root.",
    inputSchema: {
      path: z.string().describe("Absolute path to the new project root directory"),
    },
  },
  async ({ path: workspacePath }) => {
    activeWorkspacePath = workspacePath;
    const results: Record<string, any> = {};
    const languages: Language[] = [];
    if (config.python.enabled) languages.push("python");
    if (config.typescript.enabled) languages.push("typescript");
    if (config.vue.enabled) languages.push("vue");

    await Promise.all(
      languages.map(async (lang) => {
        try {
          // Only call if backend is already started
          if (startedBackends.has(lang)) {
            const result = await backendManager.callTool(lang, "switch_workspace", { path: workspacePath });
            results[lang] = JSON.parse(result.content[0].text);
          } else {
            results[lang] = { status: "not_started", message: "Workspace will be set when backend starts" };
          }
        } catch (error) {
          results[lang] = { error: String(error) };
        }
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            workspace: workspacePath,
            results,
          }, null, 2),
        },
      ],
    };
  }
);

/**
 * Pre-register all tools.
 * 1. Unified tools (hover, definition, etc.) with automatic routing.
 * 2. Language-specific tools with prefixes.
 */
function preRegisterTools(): void {
  // 1. Register Unified Tools
  for (const tool of UNIFIED_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: `${tool.description} (unified tool, routes automatically by file extension)`,
        inputSchema: tool.schema,
      },
      async (args) => {
        // Find the target path argument
        const filePath = (args.file as string) || (args.path as string);
        
        // Handle search without path (uses active workspace implicitly via backend logic)
        // But for routing, we need to know which backend to ask.
        // If no path is provided for search, we might want to query ALL active backends?
        // Or default to a primary one.
        // For now, let's keep search simple: if no path, we can't infer language easily unless we check active workspace.
        
        // Special case for search
        if (tool.name === "search" && !filePath) {
             // For global search without path, we might need a different strategy.
             // But for now, let's error if we can't determine context, or default to all if possible.
             // Actually, search tool in backends now supports optional path.
             // If we want to support "search in current context", we need to know what the context is.
             // Let's iterate over started backends and search in all?
             // That's complex. Let's require path for now or default to python if active.
             // Better: Allow search to take a 'language' param optionally, or infer from active workspace if only one is active.
             
             // Let's implement a simple "try all enabled" for global search
             const languages: Language[] = ["python", "typescript", "vue"];
             const results = [];
             for (const lang of languages) {
                 // Only search if backend is started to avoid slow startup for just a search
                 if (startedBackends.has(lang)) {
                     try {
                         const res = await backendManager.callTool(lang, "search", args as Record<string, unknown>);
                         results.push(JSON.parse(res.content[0].text));
                     } catch (e) {
                         // ignore
                     }
                 }
             }
             if (results.length === 0) {
                 return { content: [{ type: "text", text: JSON.stringify({ matches: [], count: 0, message: "No active backends to search in. Please specify a file path to auto-start a backend." }) }] };
             }
             // Aggregate results (simplified)
             const allMatches = results.flatMap(r => r.matches || []);
             return { content: [{ type: "text", text: JSON.stringify({ matches: allMatches, count: allMatches.length }) }] };
        }

        if (!filePath) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Missing 'file' or 'path' argument required for unified routing" }) }],
          };
        }

        // Infer language from path
        const language = inferLanguageFromPath(filePath);
        if (!language) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Unsupported File Type",
                  message: `Cannot determine language for file '${filePath}'. Unified tools require a recognized file extension (.py, .ts, .vue, etc.)`,
                })
              },
            ],
          };
        }

        // Auto-start backend if not started
        if (!startedBackends.has(language)) {
          console.error(`[lsp-mcp] Auto-starting ${language} backend for unified ${tool.name}...`);
          try {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            // Sync active workspace if set
            if (activeWorkspacePath) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${activeWorkspacePath}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: activeWorkspacePath });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          } catch (error) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to start ${language} backend: ${error}` }) }],
            };
          }
        }

        // Capability Check: check if the backend actually supports this tool
        const availableTools = await backendManager.getTools(language);
        const supportsTool = availableTools.some(t => t.name === tool.name);

        if (!supportsTool) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Not Implemented",
                  message: `The '${language}' backend does not support the '${tool.name}' feature yet.`,
                  available_tools: availableTools.map(t => t.name),
                })
              },
            ],
          };
        }

        // Rename argument for specific backend mismatches if any
        const backendArgs = { ...args } as Record<string, unknown>;
        if (tool.name === "rename") {
          if (language === "python") {
            // Python backend uses 'new_name'
            backendArgs.new_name = args.newName || args.new_name;
          } else {
            // TS/Vue uses 'newName'
            backendArgs.newName = args.newName || args.new_name;
          }
        }

        // Call the actual backend tool
        return backendManager.callTool(language, tool.name, backendArgs);
      }
    );
    registeredTools.add(tool.name);
  }

  // 2. Register Language-Specific Tools
  const languages: Language[] = ["python", "typescript", "vue"];
  for (const language of languages) {
    const tools = LANGUAGE_SPECIFIC_TOOLS[language];
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
          if (!startedBackends.has(language)) {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            // Sync active workspace if set
            if (activeWorkspacePath) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${activeWorkspacePath}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: activeWorkspacePath });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          }
          return backendManager.callTool(language, tool.name, args as Record<string, unknown>);
        }
      );
      registeredTools.add(namespacedName);
    }
  }

  console.error(`[lsp-mcp] Unified and language-specific tools registered`);
}

// Pre-register all tools
preRegisterTools();

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