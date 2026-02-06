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
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
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
// Cursor storage for paged high-volume responses
const cursorStore = new Map<string, { tool: string; items: any[]; createdAt: number; expiresAt: number; summary?: any; count?: number }>();
const CURSOR_TTL_MS = 10 * 60 * 1000;
const CURSOR_MAX_ENTRIES = 100;
const CURSOR_SECRET = randomBytes(16).toString("hex");
let vueBundledDepsMissingCache: boolean | null = null;

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
// Helper Functions for New Tools
// ============================================================================ 

/**
 * Generate a visual tree structure of the project, focusing on code files.
 */
function getProjectStructure(
  dirPath: string,
  maxDepth = 3,
  maxEntries = 300
): { tree: string; shownEntries: number; truncated: boolean } {
  const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "__pycache__", ".venv", ".idea", ".vscode", ".next", ".nuxt"]);
  const KEY_FILES = new Set(["package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "README.md", "Dockerfile", "docker-compose.yml", "cargo.toml", "go.mod", "gemfile"]);
  let shownEntries = 0;
  let truncated = false;

  const walk = (currentPath: string, depth: number): string => {
    if (depth > maxDepth || truncated) return "";

    let output = "";
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return "";
    }

    // Sort: Directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // Skip hidden files by default
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (shownEntries >= maxEntries) {
        truncated = true;
        break;
      }

      shownEntries++;
      const isDir = entry.isDirectory();
      const indent = "  ".repeat(depth);
      const marker = isDir ? "📁 " : "📄 ";
      const isKeyFile = KEY_FILES.has(entry.name.toLowerCase());
      const extra = isKeyFile ? " (config)" : "";

      output += `${indent}${marker}${entry.name}${extra}\n`;

      if (isDir) {
        output += walk(path.join(currentPath, entry.name), depth + 1);
      }
    }

    return output;
  };

  return {
    tree: walk(dirPath, 0),
    shownEntries,
    truncated,
  };
}

/**
 * Get list of files changed in git (working tree + staged).
 */
function getGitChangedFiles(cwd: string): string[] {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const files = new Set<string>();
    
    // Working tree changes
    try {
        const stdout = execSync("git diff --name-only", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] });
        stdout.split('\n').forEach(f => { if (f.trim()) files.add(path.resolve(gitRoot, f.trim())); });
    } catch (e) { /* ignore */ }

    // Staged changes
    try {
        const stdout = execSync("git diff --staged --name-only", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] });
        stdout.split('\n').forEach(f => { if (f.trim()) files.add(path.resolve(gitRoot, f.trim())); });
    } catch (e) { /* ignore */ }
    
    return Array.from(files);
  } catch (error) {
    return [];
  }
}

/**
 * Validate and fuzzy-fix line/column positions.
 * Reads the file to ensure coordinates are within bounds.
 */
function validateAndFixPosition(filePath: string, line: number, column: number): { line: number, column: number, warning?: string } {
    try {
        if (!fs.existsSync(filePath)) return { line, column };
        
        // Don't read huge files for this check
        const stats = fs.statSync(filePath);
        if (stats.size > 1024 * 1024) return { line, column }; // Skip for > 1MB

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        // 1-based line correction
        let newLine = line;
        let warning = "";
        
        if (newLine > lines.length) {
            newLine = lines.length;
            warning = `Line ${line} out of bounds (max ${lines.length}). Clamped to ${newLine}.`;
        }
        if (newLine < 1) {
            newLine = 1;
            warning = `Line ${line} must be positive. Clamped to 1.`;
        }
        
        // 1-based column correction
        // Get line content (0-based index)
        const lineContent = lines[newLine - 1] || "";
        let newColumn = column;
        
        // Allow column to be line length + 1 (end of line)
        const maxCol = lineContent.length + 1;
        
        if (newColumn > maxCol) {
            newColumn = maxCol;
            const w = `Column ${column} out of bounds (max ${maxCol}). Clamped to ${newColumn}.`;
            warning = warning ? `${warning} ${w}` : w;
        }
        if (newColumn < 1) {
            newColumn = 1;
            const w = `Column ${column} must be positive. Clamped to 1.`;
            warning = warning ? `${warning} ${w}` : w;
        }
        
        return { line: newLine, column: newColumn, warning: warning || undefined };
    } catch (e) {
        // Fallback if anything fails
        return { line, column };
    }
}

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
  "doctor",
  {
    description: "Run environment and backend readiness checks for out-of-box troubleshooting.",
    inputSchema: {
      probe_backends: z.boolean().default(false).optional(),
      page_size: z.number().int().positive().default(50).optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ probe_backends, page_size, cursor }) => {
    const pageSize = typeof page_size === "number" ? page_size : 50;
    if (typeof cursor === "string") {
      const page = readCursorPage("doctor", cursor, pageSize);
      if (!page.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify(page.data) }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: page.data.items,
            count: page.data.count,
            summary: page.data.summary,
            page: page.data.page,
            next: page.data.page.has_more
              ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
              : null,
          }),
        }],
      };
    }

    const checkCommand = (command: string, versionArgs = ["--version"]) => {
      try {
        const out = spawnSync(command, versionArgs, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return {
          available: out.status === 0,
          code: out.status,
          output: (out.stdout || out.stderr || "").trim().split("\n")[0],
        };
      } catch (error) {
        return {
          available: false,
          code: -1,
          output: String(error),
        };
      }
    };

    const checks = {
      node: checkCommand("node"),
      npx: checkCommand("npx"),
      uv: checkCommand("uv"),
      bun: checkCommand("bun"),
    };

    const enabledLanguages = Object.keys(config.languages).filter((lang) => config.languages[lang]?.enabled);
    const backendCommands = Object.fromEntries(
      enabledLanguages.map((lang) => {
        const cmd = backendManager.getVersions().find((v) => v.language === lang)?.command ?? "not configured";
        return [lang, cmd];
      })
    );

    const probeResults: Record<string, any> = {};
    if (probe_backends) {
      for (const lang of enabledLanguages) {
        try {
          await backendManager.getBackend(lang);
          startedBackends.add(lang);
          probeResults[lang] = { ok: true };
        } catch (error) {
          probeResults[lang] = { ok: false, error: String(error) };
        }
      }
    }

    const recommendations: string[] = [];
    if (!checks.node.available) recommendations.push("Install Node.js and ensure `node` is in PATH.");
    if (!checks.npx.available) recommendations.push("Ensure npm/npx is available in PATH.");
    if (!checks.uv.available && config.languages.python?.enabled) recommendations.push("Install uv for Python backend support.");
    if (!checks.bun.available) recommendations.push("Install Bun if you run this server from source.");

    const result = {
      ok: recommendations.length === 0,
      checks,
      activeWorkspacePath,
      enabledLanguages,
      backendCommands,
      probe_backends: !!probe_backends,
      probeResults: probe_backends ? probeResults : undefined,
      recommendations,
    };

    const items: Array<{ kind: string; key: string; value: unknown }> = [];
    for (const [name, check] of Object.entries(checks)) {
      items.push({ kind: "runtime_check", key: name, value: check });
    }
    for (const [lang, command] of Object.entries(backendCommands)) {
      items.push({ kind: "backend_command", key: lang, value: command });
    }
    for (const [lang, probe] of Object.entries(probeResults)) {
      items.push({ kind: "backend_probe", key: lang, value: probe });
    }
    recommendations.forEach((rec, idx) => {
      items.push({ kind: "recommendation", key: `r${idx + 1}`, value: rec });
    });

    const doctorSummary = {
      ok: result.ok,
      activeWorkspacePath,
      enabledLanguages,
      recommendations_count: recommendations.length,
      item_count: items.length,
    };
    const doctorCursor = makeCursor("doctor", items, items.length, doctorSummary);
    const firstPage = readCursorPage("doctor", doctorCursor, pageSize);
    if (!firstPage.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(firstPage.data) }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...result,
          items: firstPage.data.items,
          page: firstPage.data.page,
          next: firstPage.data.page.has_more
            ? { tool: "expand_result", arguments: { cursor: firstPage.data.page.next_cursor, page_size: pageSize } }
            : null,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "expand_result",
  {
    description: "Fetch the next page for a previously paged response using its cursor.",
    inputSchema: {
      cursor: z.string().describe("Cursor returned by a previous paged response"),
      page_size: z.number().int().positive().default(200).optional(),
    },
  },
  async ({ cursor, page_size }) => {
    const pageSize = typeof page_size === "number" ? page_size : 200;
    const page = readCursorPageAny(cursor, pageSize);
    if (!page.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(page.data) }],
      };
    }

    const payload: Record<string, unknown> = {
      tool: page.tool,
      items: page.data.items,
      count: page.data.count,
      summary: page.data.summary,
      page: page.data.page,
      next: page.data.page.has_more
        ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
        : null,
    };
    if (page.tool === "diagnostics") payload.diagnostics = page.data.items;
    if (page.tool === "references") payload.references = page.data.items;
    if (page.tool === "search" || page.tool === "workspace_symbol") payload.matches = page.data.items;
    if (page.tool === "project_structure" || page.tool === "summarize_file" || page.tool === "read_file_with_hints") {
      payload.lines = page.data.items;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
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
  { name: "references", description: "Find all references to a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "completions", description: "Get code completion suggestions at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), limit: z.number().int().positive().default(20).optional() } },
  { name: "signature_help", description: "Get function signature help at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "symbols", description: "Extract symbols (classes, functions, methods, variables) from a file", schema: { file: z.string(), query: z.string().optional() } },
  { name: "diagnostics", description: "Get type errors/warnings. NOTE: On mixed-language directories, it only checks the primary language (TS > Python). Prefer specific subdirectories or 'git_diagnostics'.", schema: { path: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional(), summary_only: z.boolean().default(false).optional() } },
  { name: "rename", description: "Preview renaming a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), newName: z.string() } },
  { name: "update_document", description: "Update file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
  { name: "search", description: "Search for a pattern in files using ripgrep. Uses active workspace if path is omitted.", schema: { pattern: z.string().optional(), query: z.string().optional(), path: z.string().optional(), glob: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "summarize_file", description: "Get a high-level outline of a file (classes, functions, methods) to understand its structure without reading the full content.", schema: { file: z.string(), max_symbols: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "read_file_with_hints", description: "Read file content with inlay hints (type annotations, parameter names) inserted as comments. Useful for understanding complex code.", schema: { file: z.string(), start_line: z.number().int().positive().default(1).optional(), max_lines: z.number().int().positive().default(300).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "code_action", description: "Get available code actions (refactors and quick fixes) at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "run_code_action", description: "Apply a code action (refactor or quick fix)", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), kind: z.enum(["refactor", "quickfix"]), name: z.string(), actionName: z.string().optional(), preview: z.boolean().default(false).optional() } },
  { name: "workspace_symbol", description: "Search for a symbol (class, function, etc.) across the entire workspace. Returns locations that can be used with peek_definition.", schema: { query: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "peek_definition", description: "Go to definition and return the surrounding code context immediately. Reduces round-trips compared to definition() + read_file().", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "project_structure", description: "Get a visual tree structure of the project to understand hierarchy and identify key files. Ignores build artifacts.", schema: { path: z.string().optional(), max_depth: z.number().int().positive().max(10).default(3).optional(), max_entries: z.number().int().positive().default(300).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "git_diagnostics", description: "Check for errors/warnings ONLY in files changed in Git (working tree + staged). Useful for checking your changes.", schema: { } },
];

/**
 * Helper to apply inlay hints to file content.
 */
function applyInlayHints(content: string, hints: any[], language: string): string {
  const lines = content.split('\n');
  // Copy to avoid mutating original split array if we used it elsewhere (safety)
  const resultLines = [...lines];
  
  // Normalize and sort hints reverse
  const normalizedHints = hints.map(h => {
    let line: number, char: number;
    let label = "";
    
    // Extract label
    if (typeof h.label === 'string') label = h.label;
    else if (Array.isArray(h.label)) label = h.label.map((p: any) => p.value).join('');
    
    // Extract position
    if (language === 'typescript') {
        // TS backend wrapper returns { position: { line, column } } (1-based)
        // See backends/typescript/src/index.ts
        line = h.position.line - 1;
        char = h.position.column - 1;
    } else {
        // Python/Vue backends return raw LSP { position: { line, character } } (0-based)
        line = h.position.line;
        char = h.position.character;
    }
    
    return { line, char, label, kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight };
  }).sort((a, b) => {
    if (a.line !== b.line) return b.line - a.line;
    return b.char - a.char;
  });
  
  for (const hint of normalizedHints) {
    if (hint.line < 0 || hint.line >= resultLines.length) continue;
    
    const lineContent = resultLines[hint.line];
    // In strict mode we might check char bounds, but LSP can point past end of line
    if (hint.char < 0) continue; 
    
    // Split line
    const prefix = lineContent.substring(0, hint.char);
    const suffix = lineContent.substring(hint.char);
    
    let hintText = hint.label;
    
    // Formatting style:
    // Kind 1 (Type):   `variable/*: type*/`
    // Kind 2 (Param):  `func(/*name:*/ arg)`
    // Other:           `/*label*/`
    
    let formatted = "";
    if (hint.kind === 1) {
        formatted = `/*: ${hintText.trim()}*/`;
        // Type hints usually need a space before if not present
        if (!hint.paddingLeft && prefix.length > 0 && !prefix.endsWith(" ")) formatted = " " + formatted;
    } else if (hint.kind === 2) {
        formatted = `/*${hintText.trim()}:*/`;
        // Param hints usually need a space after
        if (!hint.paddingRight) formatted = formatted + " ";
    } else {
        formatted = `/*${hintText}*/`;
    }
    
    resultLines[hint.line] = prefix + formatted + suffix;
  }
  
  return resultLines.join('\n');
}

/**
 * Helper to format document symbols into a Markdown outline.
 */
function formatSymbolsToMarkdown(symbols: any[], depth = 0): string {
  let output = "";
  const indent = "  ".repeat(depth);
  
  for (const symbol of symbols) {
    const kind = symbol.kind ? `[${symbol.kind.toLowerCase()}]` : "";
    const line = symbol.range?.start?.line ?? symbol.line ?? "?"; // Handle both standard LSP and flattened format
    
    output += `${indent}- ${kind} ${symbol.name} (line ${line})\n`;
    
    if (symbol.children && symbol.children.length > 0) {
      output += formatSymbolsToMarkdown(symbol.children, depth + 1);
    }
  }
  
  return output;
}

function extractSearchLikeItems(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  const candidates = [parsed.matches, parsed.results, parsed.symbols, parsed.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractSearchLikeCount(parsed: any, items: any[]): number {
  return typeof parsed?.count === "number" ? parsed.count : items.length;
}

function extractReferencesItems(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.references)) return parsed.references;
  return [];
}

function extractReferencesCount(parsed: any, items: any[]): number {
  return typeof parsed?.count === "number" ? parsed.count : items.length;
}

function isInlayHintUnsupportedError(errorText: string): boolean {
  const text = errorText.toLowerCase();
  return (
    text.includes("textdocument/inlayhint") ||
    text.includes("unhandled method") ||
    text.includes("method not found") ||
    text.includes("not implemented") ||
    text.includes("unknown tool") ||
    text.includes("tool not found") ||
    text.includes("inlay_hints") ||
    text.includes("-32601")
  );
}

function extractIdentifierAtPosition(fileContent: string, line: number, column: number): string | null {
  const lines = fileContent.split("\n");
  const lineIdx = line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const text = lines[lineIdx];
  if (!text) return null;
  const charIdx = Math.max(0, Math.min(column - 1, Math.max(0, text.length - 1)));
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  const nearestToken = (() => {
    const tokenRegex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let best: { value: string; distance: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = tokenRegex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length - 1;
      const distance = charIdx >= start && charIdx <= end
        ? 0
        : Math.min(Math.abs(charIdx - start), Math.abs(charIdx - end));
      if (!best || distance < best.distance) {
        best = { value: m[0], distance };
      }
    }
    return best;
  })();

  if (!nearestToken || nearestToken.distance > 24) {
    return null;
  }

  let anchor = charIdx;
  if (!isWord(text[anchor])) {
    for (let delta = 1; delta <= 24; delta++) {
      const left = anchor - delta;
      const right = anchor + delta;
      if (left >= 0 && isWord(text[left])) {
        anchor = left;
        break;
      }
      if (right < text.length && isWord(text[right])) {
        anchor = right;
        break;
      }
    }
  }

  if (!isWord(text[anchor])) {
    return nearestToken.value;
  }

  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  const ident = text.slice(start, end).trim();
  return ident || nearestToken.value;
}

function buildVueFallbackSymbols(fileContent: string, query?: string): Array<{ name: string; kind: string; line: number; column: number }> {
  const symbols: Array<{ name: string; kind: string; line: number; column: number }> = [];
  const lines = fileContent.split("\n");
  const pattern = /\b(const|let|var|function|class|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(lines[i])) !== null) {
      const name = match[2];
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: match[1],
        line: i + 1,
        column: match.index + 1,
      });
    }
  }
  return symbols;
}

function findWorkspaceIdentifierHits(identifier: string, workspacePath?: string): Array<{ file: string; line: number; column: number; text: string }> {
  if (!workspacePath || !identifier) return [];
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\b${escaped}\\b`;
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "-g",
    "*.vue",
    "-g",
    "*.ts",
    "-g",
    "*.tsx",
    "-g",
    "*.js",
    "-g",
    "*.jsx",
    pattern,
    ".",
  ];
  const result = spawnSync("rg", args, { cwd: workspacePath, encoding: "utf-8" });
  if (result.error || typeof result.stdout !== "string" || result.stdout.trim().length === 0) {
    return [];
  }

  const hits: Array<{ file: string; line: number; column: number; text: string }> = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({
      file: path.join(workspacePath, m[1]),
      line: Number(m[2]),
      column: Number(m[3]),
      text: m[4],
    });
    if (hits.length >= 500) break;
  }
  return hits;
}

function findDeclarationInFile(content: string, identifier: string): { line: number; column: number } | null {
  const decl = new RegExp(`\\b(const|let|var|function|class|interface|type)\\s+${identifier}\\b`);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (!m) continue;
    return { line: i + 1, column: m.index + 1 };
  }
  return null;
}

function bundledVueSemanticDepsMissing(): boolean {
  if (vueBundledDepsMissingCache !== null) return vueBundledDepsMissingCache;
  try {
    const bundledPkgPath = require.resolve("../dist/bundled/vue/package.json");
    const bundledRoot = path.dirname(bundledPkgPath);
    const hasTypeScript = fs.existsSync(path.join(bundledRoot, "node_modules", "typescript", "lib", "tsserver.js"));
    const hasLanguageServer = fs.existsSync(path.join(bundledRoot, "node_modules", "@vue", "language-server"));
    vueBundledDepsMissingCache = !(hasTypeScript && hasLanguageServer);
    return vueBundledDepsMissingCache;
  } catch {
    vueBundledDepsMissingCache = false;
    return false;
  }
}

function buildVueDiagnosticsFallback(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  const limit = typeof args.preview_limit === "number" ? args.preview_limit : 200;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        count: 0,
        summary: { by_severity: {}, by_file: {} },
        preview: { shown: 0, limit, truncated: false },
        diagnostics: [],
        fallback: "vue_semantic_unavailable",
        next: null,
      }),
    }],
  };
}

function pickVueFallbackIdentifier(vueContent: string, args: Record<string, unknown>): string | null {
  const direct = extractIdentifierAtPosition(vueContent, Number(args.line), Number(args.column));
  if (direct) return direct;

  if (typeof args.query === "string" && args.query.trim().length > 0) {
    return args.query.trim();
  }

  const firstSymbol = buildVueFallbackSymbols(vueContent)[0];
  return firstSymbol?.name ?? null;
}

function buildVueFallbackResponse(
  toolName: string,
  filePathArg: string,
  args: Record<string, unknown>,
  activeWorkspacePath?: string
): { content: Array<{ type: "text"; text: string }> } | null {
  let absVuePath = filePathArg;
  if (!path.isAbsolute(absVuePath) && activeWorkspacePath) {
    absVuePath = path.join(activeWorkspacePath, absVuePath);
  }
  if (!absVuePath || !fs.existsSync(absVuePath)) return null;

  const vueContent = fs.readFileSync(absVuePath, "utf-8");
  if (toolName === "symbols") {
    const fallbackSymbols = buildVueFallbackSymbols(vueContent, typeof args.query === "string" ? args.query : undefined);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ symbols: fallbackSymbols, count: fallbackSymbols.length, fallback: "vue_regex" }),
      }],
    };
  }

  if (toolName === "hover") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          contents: `symbol ${ident}`,
          documentation: "Fallback hover for Vue file (semantic server returned no info).",
          fallback: "vue_identifier",
        }),
      }],
    };
  }

  if (toolName === "definition") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const localDecl = findDeclarationInFile(vueContent, escaped);
    if (localDecl) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: absVuePath,
            line: localDecl.line,
            column: localDecl.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }

    const workspaceHits = findWorkspaceIdentifierHits(ident, activeWorkspacePath);
    for (const hit of workspaceHits) {
      if (!fs.existsSync(hit.file)) continue;
      const fileContent = fs.readFileSync(hit.file, "utf-8");
      const decl = findDeclarationInFile(fileContent, escaped);
      if (!decl) continue;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: hit.file,
            line: decl.line,
            column: decl.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }
    if (workspaceHits.length > 0) {
      const first = workspaceHits[0];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: first.file,
            line: first.line,
            column: first.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }
  }

  if (toolName === "references") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    const refs = findWorkspaceIdentifierHits(ident, activeWorkspacePath).map((h) => ({
      file: h.file,
      line: h.line,
      column: h.column,
    }));
    if (refs.length === 0) {
      const localPattern = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      const lines = vueContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        localPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = localPattern.exec(lines[i])) !== null) {
          refs.push({ file: absVuePath, line: i + 1, column: match.index + 1 });
        }
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ references: refs, count: refs.length, fallback: "vue_regex" }),
      }],
    };
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function cleanupCursors(): void {
  const now = Date.now();
  for (const [key, value] of cursorStore.entries()) {
    if (now >= value.expiresAt || now - value.createdAt > CURSOR_TTL_MS) {
      cursorStore.delete(key);
    }
  }

  if (cursorStore.size > CURSOR_MAX_ENTRIES) {
    const sorted = Array.from(cursorStore.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const over = cursorStore.size - CURSOR_MAX_ENTRIES;
    for (let i = 0; i < over; i++) {
      cursorStore.delete(sorted[i][0]);
    }
  }
}

function signCursorBase(base: string): string {
  return createHash("sha256").update(`${base}:${CURSOR_SECRET}`).digest("hex").slice(0, 12);
}

function parseCursor(cursor: string): { baseCursor: string; offset: number; valid: boolean } {
  const offsetMatch = /:o(\d+)$/.exec(cursor);
  const offset = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
  const baseCursor = cursor.replace(/:o\d+$/, ":o0");
  const sigMatch = /:s([a-f0-9]{12}):o0$/.exec(baseCursor);
  if (!sigMatch) {
    return { baseCursor, offset, valid: false };
  }
  const signedPart = baseCursor.replace(/:s[a-f0-9]{12}:o0$/, "");
  const expected = signCursorBase(signedPart);
  return { baseCursor, offset, valid: expected === sigMatch[1] };
}

function makeCursor(tool: string, items: any[], count?: number, summary?: any): string {
  cleanupCursors();
  const createdAt = Date.now();
  const unsignedBase = `${tool}:${createdAt.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  const sig = signCursorBase(unsignedBase);
  const token = `${unsignedBase}:s${sig}:o0`;
  cursorStore.set(token, {
    tool,
    items,
    createdAt,
    expiresAt: createdAt + CURSOR_TTL_MS,
    count,
    summary,
  });
  return token;
}

function readCursorPage(tool: string, cursor: string, pageSize: number): { ok: true; data: any } | { ok: false; data: any } {
  cleanupCursors();
  const parsed = parseCursor(cursor);
  if (!parsed.valid) {
    return { ok: false, data: { error: "Invalid cursor signature" } };
  }
  const baseCursor = parsed.baseCursor;
  const entry = cursorStore.get(baseCursor);
  if (!entry || entry.tool !== tool) {
    return { ok: false, data: { error: "Invalid or expired cursor" } };
  }
  if (Date.now() >= entry.expiresAt) {
    cursorStore.delete(baseCursor);
    return { ok: false, data: { error: "Cursor expired", expires_at: entry.expiresAt } };
  }

  const offset = parsed.offset;
  const pageItems = entry.items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < entry.items.length;

  return {
    ok: true,
    data: {
      items: pageItems,
      count: entry.count ?? entry.items.length,
      summary: entry.summary,
      page: {
        shown: pageItems.length,
        offset,
        page_size: pageSize,
        has_more: hasMore,
        next_cursor: hasMore ? `${baseCursor.replace(/:o0$/, "")}:o${nextOffset}` : null,
        expires_at: entry.expiresAt,
      },
    },
  };
}

function readCursorPageAny(cursor: string, pageSize: number): { ok: true; tool: string; data: any } | { ok: false; data: any } {
  cleanupCursors();
  const parsed = parseCursor(cursor);
  if (!parsed.valid) {
    return { ok: false, data: { error: "Invalid cursor signature" } };
  }
  const baseCursor = parsed.baseCursor;
  const entry = cursorStore.get(baseCursor);
  if (!entry) {
    return { ok: false, data: { error: "Invalid or expired cursor" } };
  }
  const page = readCursorPage(entry.tool, cursor, pageSize);
  if (!page.ok) {
    return page;
  }
  return { ok: true, tool: entry.tool, data: page.data };
}

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
  ],
  vue: [],
};

/**
 * Backward-compatible namespaced aliases for unified tools.
 * Example: python_hover -> hover
 */
const LEGACY_NAMESPACED_UNIFIED_TOOL_NAMES = new Set([
  "hover",
  "definition",
  "references",
  "completions",
  "diagnostics",
  "symbols",
  "rename",
  "search",
  "signature_help",
  "update_document",
]);

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
    
    // Get all enabled languages
    const languages = Object.keys(config.languages).filter(
      (lang) => config.languages[lang].enabled
    );

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
        // --- Smart Parameter Correction (Fuzzy Logic) ---
        // Automatically fix out-of-bounds line/column numbers to prevent backend errors
        let paramWarning: string | undefined;
        if (typeof args.line === 'number' && typeof args.column === 'number') {
             const targetFile = (args.file as string) || (args.path as string);
             if (targetFile) {
                 let checkPath = targetFile;
                 if (!path.isAbsolute(checkPath) && activeWorkspacePath) {
                     checkPath = path.join(activeWorkspacePath, checkPath);
                 } else if (!path.isAbsolute(checkPath)) {
                     checkPath = path.resolve(checkPath);
                 }
                 
                 const fixed = validateAndFixPosition(checkPath, args.line, args.column);
                 if (fixed.warning) {
                     console.error(`[lsp-mcp] Auto-corrected params for ${tool.name}: ${fixed.warning}`);
                     args.line = fixed.line;
                     args.column = fixed.column;
                     paramWarning = `(Auto-corrected: ${fixed.warning})`;
                 }
             }
        }

        // --- Special Tool: Project Structure ---
        if (tool.name === "project_structure") {
             const targetPath = (args.path as string) || activeWorkspacePath || process.cwd();
             const maxDepth = typeof args.max_depth === "number" ? args.max_depth : 3;
             const maxEntries = typeof args.max_entries === "number" ? args.max_entries : 300;
             const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
             const { tree, shownEntries, truncated } = getProjectStructure(targetPath, maxDepth, maxEntries);
             const lines = tree.split("\n").filter(Boolean);

             if (typeof args.page_size === "number") {
               const cursor = makeCursor(tool.name, lines, lines.length, {
                 path: targetPath,
                 shown_entries: shownEntries,
                 truncated_preview: truncated,
               });
               const page = readCursorPage(tool.name, cursor, pageSize);
               if (!page.ok) {
                 return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
               }
               return {
                 content: [{
                   type: "text",
                   text: JSON.stringify({
                     lines: page.data.items,
                     count: lines.length,
                     summary: page.data.summary,
                     page: page.data.page,
                     next: page.data.page.has_more
                       ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                       : null,
                   }),
                 }],
               };
             }

             const tail = truncated
               ? `\n\n(Preview truncated at ${shownEntries} entries. Use 'path' on a subdirectory or increase 'max_entries' / 'max_depth' to expand.)`
               : `\n\n(Shown entries: ${shownEntries})`;
             return {
                 content: [{ type: "text", text: `Project Structure for ${targetPath}:\n\n${tree}${tail}` }]
             };
        }

        // --- Special Tool: Git Diagnostics ---
        if (tool.name === "git_diagnostics") {
             const cwd = activeWorkspacePath || process.cwd();
             const changedFiles = getGitChangedFiles(cwd);
             
             if (changedFiles.length === 0) {
                 return { content: [{ type: "text", text: "No changed files found in git." }] };
             }
             
             const results: string[] = [];
             const failedBackendStart = new Map<string, string>();
             
             // Group by language to batch start backends? No, just iterate.
             for (const file of changedFiles) {
                 const language = inferLanguageFromPath(file, config);
                 if (!language) continue; // Skip unsupported files

                 if (failedBackendStart.has(language)) {
                     results.push(`⚠️ ${path.basename(file)}: Skipped (${language} backend unavailable: ${failedBackendStart.get(language)})`);
                     continue;
                 }
                 
                 // Start backend if needed
                 if (!startedBackends.has(language)) {
                     try {
                         await backendManager.getBackend(language);
                         startedBackends.add(language);
                     } catch (e) {
                         const reason = e instanceof Error ? e.message : String(e);
                         failedBackendStart.set(language, reason);
                         results.push(`⚠️ ${path.basename(file)}: Could not check (${language} backend failed to start: ${reason})`);
                         continue;
                     }
                 }
                 
                 try {
                     const relativePath = path.relative(cwd, file);
                     const res = await backendManager.callTool(language, "diagnostics", { path: relativePath });
                     const parsed = JSON.parse(res.content[0].text);
                     
                     if (parsed.error) {
                         results.push(`⚠️ ${path.basename(file)}: Backend error: ${parsed.error}`);
                         continue;
                     }

                     let diagnostics = [];
                     if (Array.isArray(parsed)) diagnostics = parsed;
                     else if (parsed.diagnostics && Array.isArray(parsed.diagnostics)) diagnostics = parsed.diagnostics;
                     else {
                         console.error(`[lsp-mcp] Unexpected diagnostics format for ${file}:`, parsed);
                         results.push(`⚠️ ${path.basename(file)}: Unexpected response format`);
                         continue;
                     }
                     
                     // Format output
                     if (diagnostics.length === 0) {
                         results.push(`✅ ${path.basename(file)}: No errors`);
                     } else {
                         const errors = diagnostics.map((d: any) => `  - [Line ${d.range?.start?.line ?? d.line ?? '?'}] ${d.message}`).join('\n');
                         results.push(`❌ ${path.basename(file)}:\n${errors}`);
                     }
                 } catch (e) {
                     results.push(`⚠️ ${path.basename(file)}: Check failed (${e})`);
                 }
             }
             
             return { content: [{ type: "text", text: `Git Diagnostics Report:\n\n${results.join('\n\n')}` }] };
        }

        // Cursor paging for high-volume tools
        if (
          (tool.name === "search" ||
            tool.name === "workspace_symbol" ||
            tool.name === "diagnostics" ||
            tool.name === "references" ||
            tool.name === "project_structure" ||
            tool.name === "summarize_file" ||
            tool.name === "read_file_with_hints") &&
          typeof args.cursor === "string"
        ) {
          const pageSize = typeof args.page_size === "number"
            ? args.page_size
            : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
          const page = readCursorPage(tool.name, args.cursor, pageSize);
          if (!page.ok) {
            return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
          }

          const itemsKey =
            tool.name === "diagnostics"
              ? "diagnostics"
              : tool.name === "references"
                ? "references"
              : (tool.name === "search" || tool.name === "workspace_symbol")
                ? "matches"
                : "lines";
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                [itemsKey]: page.data.items,
                count: page.data.count,
                summary: page.data.summary,
                page: page.data.page,
                next: page.data.page.has_more
                  ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                  : null,
              }),
            }],
          };
        }

        // For search, if workspace is known, auto-bind path so it can use normal routed flow.
        if (tool.name === "search" && !args.path && activeWorkspacePath) {
          args.path = activeWorkspacePath;
        }

        // Find the target path argument
        const filePath = (args.file as string) || (args.path as string);
        
        // Handle search without path (uses active workspace implicitly via backend logic)
        // Use active workspace inference to auto-start at least one backend for better OOB behavior
        if ((tool.name === "search" || tool.name === "workspace_symbol") && !filePath) {
             const enabledLanguages = Object.keys(config.languages).filter(
               (lang) => config.languages[lang].enabled
             );
             const pageSize = typeof args.page_size === "number"
               ? args.page_size
               : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
             const backendArgs = { ...(args as Record<string, unknown>) };
             delete backendArgs.preview_limit;
             delete backendArgs.page_size;
             delete backendArgs.cursor;
             if (tool.name === "search" && !backendArgs.path && activeWorkspacePath) {
               backendArgs.path = activeWorkspacePath;
             }
             if (tool.name === "search" && typeof backendArgs.pattern !== "string") {
               const query = typeof args.query === "string" ? args.query.trim() : "";
               if (query.length > 0) {
                 backendArgs.pattern = query;
               }
             }
             if (tool.name === "workspace_symbol" && !backendArgs.path && activeWorkspacePath) {
               backendArgs.path = activeWorkspacePath;
             }
             const workspaceQuery =
               tool.name === "workspace_symbol" && typeof args.query === "string" && args.query.trim().length > 0
                 ? args.query.trim()
                 : null;
             const startedEnabled = enabledLanguages.filter((lang) => startedBackends.has(lang));
             const startAndSyncBackend = async (lang: string) => {
               await backendManager.getBackend(lang);
               startedBackends.add(lang);
               if (activeWorkspacePath) {
                 await backendManager.callTool(lang, "switch_workspace", { path: activeWorkspacePath });
               }
             };

             if (tool.name === "workspace_symbol") {
                 for (const lang of enabledLanguages) {
                   if (startedBackends.has(lang)) continue;
                   try {
                     await startAndSyncBackend(lang);
                   } catch {
                     // Best-effort startup across languages for mixed-language workspaces.
                   }
                 }
             } else if (startedEnabled.length === 0) {
                 const preferred = activeWorkspacePath
                   ? inferLanguageFromPath(activeWorkspacePath, config)
                   : null;
                 const fallback = enabledLanguages.length === 1 ? enabledLanguages[0] : null;
                 const candidate = preferred || fallback;

                 if (candidate) {
                    try {
                      await startAndSyncBackend(candidate);
                    } catch (e) {
                      // Fall through to graceful empty response below
                    }
                 }
             }

             const results = [];
             let totalCount = 0;
             for (const lang of enabledLanguages) {
                 if (startedBackends.has(lang)) {
                     try {
                         let parsed: any;
                         try {
                           const res = await backendManager.callTool(lang, tool.name, backendArgs);
                           parsed = JSON.parse(res.content[0].text);
                         } catch {
                           if (!workspaceQuery) {
                             continue;
                           }
                           // Fallback for backends that don't support workspace_symbol.
                           const fallbackRes = await backendManager.callTool(lang, "search", {
                             pattern: workspaceQuery,
                           });
                           parsed = JSON.parse(fallbackRes.content[0].text);
                         }

                         let items = extractSearchLikeItems(parsed);
                         if (items.length === 0 && workspaceQuery) {
                           // Some backends may return empty workspace symbols even with valid query.
                           const fallbackRes = await backendManager.callTool(lang, "search", {
                             pattern: workspaceQuery,
                           });
                           const fallbackParsed = JSON.parse(fallbackRes.content[0].text);
                           items = extractSearchLikeItems(fallbackParsed);
                           parsed = fallbackParsed;
                         }

                         const parsedCount = extractSearchLikeCount(parsed, items);
                         totalCount += parsedCount;
                         
                         if (items.length > 0) {
                            // Tag them with language if not present
                            const remaining = Math.max(pageSize - results.length, 0);
                            if (remaining > 0) {
                              results.push(...items.slice(0, remaining).map((i: any) => ({ ...i, language: lang })));
                            }
                         }
                     } catch (e) {
                         // ignore
                     }
                 }
             }
             if (results.length === 0) {
                 return { content: [{ type: "text", text: JSON.stringify({ matches: [], count: 0, message: "No matches found. If this is your first query, call switch_workspace(path=...) or pass path=... to search." }) }] };
             }
             const cursor = makeCursor(tool.name, results, totalCount);
             const page = readCursorPage(tool.name, cursor, pageSize);
             if (!page.ok) {
               return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
             }

             return {
               content: [{
                 type: "text",
                 text: JSON.stringify({
                   matches: page.data.items,
                   count: totalCount,
                   page: page.data.page,
                   next: page.data.page.has_more
                     ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                     : null,
                 }),
               }],
             };
        }

        if (!filePath) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Missing 'file' or 'path' argument required for unified routing" }) }],
          };
        }

        // Resolve path to absolute to help inference check file existence
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            if (activeWorkspacePath) {
                absPath = path.join(activeWorkspacePath, filePath);
            } else {
                absPath = path.resolve(filePath);
            }
        }

        // Infer language from path (now uses config)
        const language = inferLanguageFromPath(absPath, config);
        if (!language) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Unsupported File Type",
                  message: `Cannot determine language for file '${filePath}'. Check configuration for supported extensions.`, 
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
            const msg = String(error);
            let hint = "";
            if (msg.includes("ENOENT")) {
                if (language === "python") hint = "Make sure 'uv' (recommended) or 'python' is installed and in your PATH.";
                else hint = "Make sure 'node' and 'npm' are installed and in your PATH.";
            } else {
                hint = "Check server logs for details. You may need to install the backend manually.";
            }
            
            return {
              content: [{ type: "text", text: JSON.stringify({ 
                  error: `Failed to start ${language} backend`, 
                  details: msg,
                  hint: hint
              }, null, 2) }],
            };
          }
        }

        // Capability Check: check if the backend actually supports this tool
        // Special case for composite tools like summarize_file (they use other tools internally)
        if (tool.name !== "summarize_file" && tool.name !== "read_file_with_hints" && tool.name !== "peek_definition") {
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
        }

        // Special case for summarize_file
        if (tool.name === "summarize_file") {
          try {
            // Call symbols tool to get the data
            const symbolsArgs = { ...(args as Record<string, unknown>) };
            delete symbolsArgs.max_symbols;
            const result = await backendManager.callTool(language, "symbols", symbolsArgs);
            const parsed = JSON.parse(result.content[0].text);
            
            if (parsed.error) {
              return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
            }

            const symbols = parsed.symbols || [];
            const summary = formatSymbolsToMarkdown(symbols);
            const maxSymbols = typeof args.max_symbols === "number" ? args.max_symbols : 200;
            const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
            const lines = summary.split("\n").filter(Boolean);
            const truncated = lines.length > maxSymbols;
            const preview = truncated ? `${lines.slice(0, maxSymbols).join("\n")}\n` : summary;

            if (typeof args.page_size === "number") {
              const cursor = makeCursor(tool.name, lines, lines.length, {
                file: filePath,
                max_symbols: maxSymbols,
              });
              const page = readCursorPage(tool.name, cursor, pageSize);
              if (!page.ok) {
                return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    lines: page.data.items,
                    count: lines.length,
                    summary: page.data.summary,
                    page: page.data.page,
                    next: page.data.page.has_more
                      ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                      : null,
                  }),
                }],
              };
            }
            
            return {
              content: [{
                type: "text",
                text: truncated
                  ? `File Summary for ${filePath} (preview ${maxSymbols}/${lines.length} symbols):\n\n${preview}\n(Use max_symbols to expand.)`
                  : `File Summary for ${filePath}:\n\n${preview || "(No symbols found)"}`
              }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to summarize file: ${error}` }) }],
            };
          }
        }
        
        // Special case for peek_definition
        if (tool.name === "peek_definition") {
          try {
            // 1. Call definition tool
            const result = await backendManager.callTool(language, "definition", args as Record<string, unknown>);
            const parsed = JSON.parse(result.content[0].text);
            
            if (parsed.error) {
               return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
            }

            // Definition can be array or single object
            let locs = Array.isArray(parsed) ? parsed : [parsed];
            if (parsed.matches) locs = parsed.matches; // Handle standardized matches format
            
            if (!locs || locs.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ message: "No definition found" }) }] };
            }

            // Take the first definition
            const def = locs[0];
            const defPath = def.file || def.uri; // Handle potential naming diffs
            
            if (!defPath) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid definition result", raw: parsed }) }] };
            }

            let defAbsPath = defPath;
            if (!path.isAbsolute(defPath) && activeWorkspacePath) {
                 defAbsPath = path.join(activeWorkspacePath, defPath);
            }
            
            if (!fs.existsSync(defAbsPath)) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Definition file not found: ${defAbsPath}`, location: def }) }] };
            }

            // 2. Read file context
            const fileContent = fs.readFileSync(defAbsPath, 'utf-8');
            const lines = fileContent.split('\n');
            
            // LSP lines are 0-based or 1-based?
            // Usually internal LSP is 0-based, but our tools expose 1-based?
            // src/tools/meta.ts says "line: z.number().int().positive()" -> 1-based input.
            // But backends usually return standardized response.
            // Let's assume the result from definition() is consistent with input: 1-based.
            // If it returns raw LSP 0-based, we might be off by one.
            // Let's assume 1-based for user-facing strings, checking definition return...
            // If definition tool output mimics 'search', it has 'line'.
            
            // Let's assume 1-based target line for now, and clamp.
            const targetLine = def.line; 
            // 0-based index
            const lineIdx = targetLine - 1; 
            
            const CONTEXT_LINES = 10;
            const startIdx = Math.max(0, lineIdx - CONTEXT_LINES);
            const endIdx = Math.min(lines.length, lineIdx + CONTEXT_LINES + 1);
            
            const contextSnippet = lines.slice(startIdx, endIdx)
                .map((line, i) => {
                    const currentLineNum = startIdx + i + 1;
                    const marker = currentLineNum === targetLine ? " >" : "  ";
                    return `${marker} ${currentLineNum.toString().padEnd(4)} | ${line}`;
                })
                .join('\n');
                
            const responseText = `Definition found in ${defPath} at line ${targetLine}:\n\n` +
                                 "```" + (language === 'python' ? 'python' : 'typescript') + "\n" +
                                 contextSnippet + "\n" +
                                 "```";
                                 
            return {
                content: [{ type: "text", text: responseText }]
            };

          } catch (error) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to peek definition: ${error}` }) }],
            };
          }
        }

        // Special case for read_file_with_hints
        if (tool.name === "read_file_with_hints") {
          try {
            // 1. Read file content (using fs)
            // Note: args.file might be relative, inferLanguageFromPath resolved it? 
            // No, inferLanguageFromPath just checked extension.
            // We need to resolve path first.
            // But we don't have resolveFilePath here (it's in backend).
            // However, we rely on backendManager.callTool to resolve it internally?
            // No, fs.readFileSync needs abs path.
            
            // We can't easily resolve path here without duplicating logic or exposing it from backend.
            // BUT: backendManager.callTool("inlay_hints") will verify path.
            // If we pass the raw 'file' arg to backend, it will resolve it and check workspace.
            // But we need to read the SAME file locally.
            
            // Workaround: We require absolute path or relative to cwd?
            // Actually, we can rely on activeWorkspacePath global if set.
            let absPath = filePath;
            if (!path.isAbsolute(filePath) && activeWorkspacePath) {
                absPath = path.join(activeWorkspacePath, filePath);
            }
            
            if (!fs.existsSync(absPath)) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: `File not found: ${absPath}` }) }] };
            }
            
            const content = fs.readFileSync(absPath, "utf-8");

            // 2. Get hints from backend
            const hintsArgs = { ...(args as Record<string, unknown>) };
            delete hintsArgs.start_line;
            delete hintsArgs.max_lines;
            delete hintsArgs.page_size;
            delete hintsArgs.cursor;
            let hints: any[] = [];
            try {
              const result = await backendManager.callTool(language, "inlay_hints", hintsArgs);
              const parsed = JSON.parse(result.content[0].text);
              if (parsed?.error) {
                const errorText = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
                if (!isInlayHintUnsupportedError(errorText)) {
                  return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
                }
              } else {
                hints = Array.isArray(parsed?.hints) ? parsed.hints : [];
              }
            } catch (error) {
              const errorText = String(error);
              if (!isInlayHintUnsupportedError(errorText)) {
                return {
                  content: [{ type: "text", text: JSON.stringify({ error: `Failed to read file with hints: ${error}` }) }],
                };
              }
            }
            
            // 3. Apply hints
            const contentWithHints = applyInlayHints(content, hints, language);
            const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
            const startLine = typeof args.start_line === "number" ? args.start_line : 1;
            const maxLines = typeof args.max_lines === "number" ? args.max_lines : 300;
            const allLines = contentWithHints.split("\n");

            if (typeof args.page_size === "number") {
              const numbered = allLines.map((line, idx) => `${String(idx + 1).padStart(5)} | ${line}`);
              const cursor = makeCursor(tool.name, numbered, numbered.length, {
                file: filePath,
                total_lines: allLines.length,
              });
              const page = readCursorPage(tool.name, cursor, pageSize);
              if (!page.ok) {
                return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    lines: page.data.items,
                    count: numbered.length,
                    summary: page.data.summary,
                    page: page.data.page,
                    next: page.data.page.has_more
                      ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                      : null,
                  }),
                }],
              };
            }

            const startIdx = Math.max(0, startLine - 1);
            const endIdx = Math.min(allLines.length, startIdx + maxLines);
            const isPreview = startIdx > 0 || endIdx < allLines.length;

            if (!isPreview) {
              return {
                content: [{
                  type: "text",
                  text: contentWithHints
                }]
              };
            }

            const snippet = allLines
              .slice(startIdx, endIdx)
              .map((line, idx) => `${String(startIdx + idx + 1).padStart(5)} | ${line}`)
              .join("\n");
            
            return {
              content: [{
                type: "text",
                text: `File preview for ${filePath} (lines ${startIdx + 1}-${endIdx} of ${allLines.length}):\n\n${snippet}\n\n(Use start_line/max_lines to expand.)`
              }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to read file with hints: ${error}` }) }],
            };
          }
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
        if (tool.name === "search" || tool.name === "workspace_symbol") {
          if (tool.name === "search" && typeof backendArgs.pattern !== "string") {
            const query = typeof args.query === "string" ? args.query.trim() : "";
            if (query.length > 0) {
              backendArgs.pattern = query;
            }
          }
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }
        if (tool.name === "references") {
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }
        if (tool.name === "diagnostics") {
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
          delete backendArgs.summary_only;
        }
        if (tool.name === "project_structure" || tool.name === "summarize_file" || tool.name === "read_file_with_hints") {
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }

        if (language === "vue" && tool.name === "diagnostics" && bundledVueSemanticDepsMissing()) {
          return buildVueDiagnosticsFallback(args as Record<string, unknown>);
        }

        // Call the actual backend tool
        const isVueFragileTool =
          language === "vue" && (tool.name === "symbols" || tool.name === "hover" || tool.name === "definition" || tool.name === "references");
        if (isVueFragileTool && bundledVueSemanticDepsMissing() && typeof filePath === "string") {
          const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, activeWorkspacePath);
          if (fallback) {
            return fallback;
          }
        }
        let backendResult;
        try {
          const callPromise = backendManager.callTool(language, tool.name, backendArgs);
          backendResult = isVueFragileTool
            ? await withTimeout(callPromise, 1200, `Vue ${tool.name}`)
            : await callPromise;
        } catch (error) {
          if (isVueFragileTool && typeof filePath === "string") {
            const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, activeWorkspacePath);
            if (fallback) {
              return fallback;
            }
          }
          throw error;
        }

        if (language === "vue" && (tool.name === "symbols" || tool.name === "hover" || tool.name === "definition" || tool.name === "references")) {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const shouldFallback =
              (tool.name === "symbols" && (parsed?.error || !Array.isArray(parsed?.symbols) || parsed.symbols.length === 0)) ||
              ((tool.name === "hover" || tool.name === "definition" || tool.name === "references") && !!parsed?.error);
            if (shouldFallback && typeof filePath === "string") {
              const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, activeWorkspacePath);
              if (fallback) {
                return fallback;
              }
            }
          } catch {
            // Keep original backend response if fallback parsing fails.
          }
        }

        // High-volume results get a compact preview by default.
        if (tool.name === "search" || tool.name === "workspace_symbol") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const items = Array.isArray(parsed)
              ? parsed
              : extractSearchLikeItems(parsed);
            const count = extractSearchLikeCount(parsed, items);
            const cursor = makeCursor(tool.name, items, count);
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  matches: page.data.items,
                  count,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            };
          } catch {
            return backendResult;
          }
        }

        if (tool.name === "references") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const items = extractReferencesItems(parsed);
            const count = extractReferencesCount(parsed, items);
            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const cursor = makeCursor(tool.name, items, count);
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  references: page.data.items,
                  count,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            };
          } catch {
            return backendResult;
          }
        }

        if (tool.name === "diagnostics") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const diagnostics = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed.diagnostics)
                ? parsed.diagnostics
                : null;
            if (!diagnostics) return backendResult;

            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const summaryOnly = !!args.summary_only;

            const severityCounts = diagnostics.reduce((acc: Record<string, number>, d: any) => {
              const sev = String(d.severity ?? "unknown");
              acc[sev] = (acc[sev] || 0) + 1;
              return acc;
            }, {});
            const fileCounts = diagnostics.reduce((acc: Record<string, number>, d: any) => {
              const key = d.file || d.uri || args.path || "unknown";
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {});

            if (summaryOnly) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    count: diagnostics.length,
                    summary: {
                      by_severity: severityCounts,
                      by_file: fileCounts,
                    },
                    preview: {
                      shown: 0,
                      limit: pageSize,
                      truncated: diagnostics.length > 0,
                    },
                    next: diagnostics.length > 0
                      ? { tool: tool.name, arguments: { path: args.path, summary_only: false, page_size: pageSize } }
                      : null,
                  }),
                }],
              };
            }

            const summary = {
              by_severity: severityCounts,
              by_file: fileCounts,
            };
            const cursor = makeCursor(tool.name, diagnostics, diagnostics.length, summary);
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  diagnostics: page.data.items,
                  count: diagnostics.length,
                  summary,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            };
          } catch {
            return backendResult;
          }
        }

        return backendResult;
      }
    );
    registeredTools.add(tool.name);
  }

  // 1.5 Register legacy namespaced aliases for common unified tools
  for (const [language, langConfig] of Object.entries(config.languages)) {
    if (!langConfig?.enabled) continue;

    for (const tool of UNIFIED_TOOLS) {
      if (!LEGACY_NAMESPACED_UNIFIED_TOOL_NAMES.has(tool.name)) continue;

      const aliasName = `${language}_${tool.name}`;
      if (registeredTools.has(aliasName)) continue;

      server.registerTool(
        aliasName,
        {
          description: `${tool.description} (legacy alias; prefer '${tool.name}')`,
          inputSchema: tool.schema,
        },
        async (args) => {
          if (!startedBackends.has(language)) {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            if (activeWorkspacePath) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${activeWorkspacePath}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: activeWorkspacePath });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          }

          const backendArgs = { ...args } as Record<string, unknown>;
          if (tool.name === "rename") {
            if (language === "python") {
              backendArgs.new_name = args.newName || args.new_name;
            } else {
              backendArgs.newName = args.newName || args.new_name;
            }
          }

          return backendManager.callTool(language, tool.name, backendArgs);
        }
      );

      registeredTools.add(aliasName);
    }
  }

  // 2. Register Language-Specific Tools
  // Iterate over configured languages
  for (const [language, langConfig] of Object.entries(config.languages)) {
    if (!langConfig?.enabled) continue;

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
  console.error("  Python:", config.languages.python?.enabled ? `enabled` : "disabled");
  console.error("  TypeScript:", config.languages.typescript?.enabled ? "enabled" : "disabled");
  console.error("  Vue:", config.languages.vue?.enabled ? "enabled" : "disabled");
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Eagerly start all enabled backends if configured
  if (config.eagerStart) {
    console.error("Eager start enabled - starting all backends now...");
    
    // Start backends in parallel
    const enabledLanguages = Object.keys(config.languages).filter(l => config.languages[l].enabled);
    await Promise.allSettled(
      enabledLanguages.map(async (lang) => {
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
