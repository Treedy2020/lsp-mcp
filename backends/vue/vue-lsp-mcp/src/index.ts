#!/usr/bin/env node
/**
 * Vue LSP MCP Server
 *
 * MCP server providing Vue Single File Component intelligence
 * using the official Vue Language Server (Volar).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

import {
  createVueLanguageService,
  getQuickInfo as getLspQuickInfo,
  getDefinition as getLspDefinition,
  getReferences as getLspReferences,
  getCompletions as getLspCompletions,
  getSignatureHelp as getLspSignatureHelp,
  getDiagnostics,
  updateDocument,
  findProjectRoot,
  getFileContent,
  offsetToPosition,
  formatDiagnostic,
  getProjectStatus,
} from "./vue-service.js";

// Direct TypeScript service as fallback
import {
  getQuickInfo as getTsQuickInfo,
  getDefinition as getTsDefinition,
  getReferences as getTsReferences,
  getCompletions as getTsCompletions,
  getSignatureHelp as getTsSignatureHelp,
  getDocumentSymbols,
  getRenameLocations,
} from "./ts-vue-service.js";

// Wrapper functions that try LSP first, then fallback to direct TS
async function getQuickInfo(file: string, line: number, column: number) {
  // Try LSP first
  const lspResult = await getLspQuickInfo(file, line, column);
  if (lspResult && lspResult.contents) {
    return lspResult;
  }
  // Fallback to direct TS service
  return getTsQuickInfo(file, line, column);
}

async function getDefinition(file: string, line: number, column: number) {
  const lspResult = await getLspDefinition(file, line, column);
  if (lspResult && lspResult.length > 0) {
    return lspResult;
  }
  return getTsDefinition(file, line, column);
}

async function getReferences(file: string, line: number, column: number) {
  const lspResult = await getLspReferences(file, line, column);
  if (lspResult && lspResult.length > 0) {
    return lspResult;
  }
  return getTsReferences(file, line, column);
}

async function getCompletions(file: string, line: number, column: number, limit: number = 20) {
  const lspResult = await getLspCompletions(file, line, column, limit);
  if (lspResult && lspResult.items && lspResult.items.length > 0) {
    return lspResult;
  }
  return getTsCompletions(file, line, column, limit);
}

async function getSignatureHelp(file: string, line: number, column: number) {
  const lspResult = await getLspSignatureHelp(file, line, column);
  if (lspResult && lspResult.signatures && lspResult.signatures.length > 0) {
    return lspResult;
  }
  return getTsSignatureHelp(file, line, column);
}

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Create MCP server
const server = new McpServer({
  name: "vue-lsp-mcp",
  version: packageJson.version,
});

// ============================================================================
// Tool: hover
// ============================================================================
server.tool(
  "hover",
  "Get type information and documentation at a specific position in a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const info = await getQuickInfo(file, line, column);
      if (!info) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No information available at this position" }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(info),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: definition
// ============================================================================
server.tool(
  "definition",
  "Go to definition of a symbol at a specific position in a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const definitions = await getDefinition(file, line, column);
      if (!definitions || definitions.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No definition found" }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(definitions.length === 1 ? definitions[0] : definitions),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: references
// ============================================================================
server.tool(
  "references",
  "Find all references to a symbol at a specific position in a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const refs = await getReferences(file, line, column);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ references: refs, count: refs.length }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: completions
// ============================================================================
server.tool(
  "completions",
  "Get code completion suggestions at a specific position in a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    limit: z.number().int().positive().default(20).describe("Maximum number of completions to return"),
  },
  async ({ file, line, column, limit }) => {
    try {
      const completions = await getCompletions(file, line, column, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            completions: completions.items,
            count: completions.items.length,
            isIncomplete: completions.isIncomplete,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: signature_help
// ============================================================================
server.tool(
  "signature_help",
  "Get function signature help at a specific position in a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const help = await getSignatureHelp(file, line, column);
      if (!help) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No signature help available" }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(help),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: diagnostics
// ============================================================================
server.tool(
  "diagnostics",
  "Get type errors and warnings for Vue SFC files",
  {
    path: z.string().describe("Path to a .vue file or directory to check"),
  },
  async ({ path: inputPath }) => {
    try {
      const absPath = path.resolve(inputPath);
      const stats = fs.statSync(absPath);

      let files: string[] = [];
      if (stats.isDirectory()) {
        // Find all Vue files in directory
        const walkDir = (dir: string): string[] => {
          const results: string[] = [];
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
              results.push(...walkDir(fullPath));
            } else if (entry.isFile() && entry.name.endsWith(".vue")) {
              results.push(fullPath);
            }
          }
          return results;
        };
        files = walkDir(absPath);
      } else {
        files = [absPath];
      }

      const allDiagnostics: ReturnType<typeof formatDiagnostic>[] = [];
      for (const file of files) {
        const diags = await getDiagnostics(file);
        for (const diag of diags) {
          allDiagnostics.push(formatDiagnostic(diag));
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            diagnostics: allDiagnostics,
            count: allDiagnostics.length,
            filesChecked: files.length,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: update_document
// ============================================================================
server.tool(
  "update_document",
  "Update Vue file content for incremental analysis without writing to disk",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    content: z.string().describe("New content for the file"),
  },
  async ({ file, content }) => {
    try {
      updateDocument(file, content);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, file }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: symbols
// ============================================================================
server.tool(
  "symbols",
  "Extract symbols (variables, functions, components) from a Vue SFC file",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    query: z.string().optional().describe("Optional filter query for symbol names"),
  },
  async ({ file, query }) => {
    try {
      const tree = await getDocumentSymbols(file);
      if (!tree) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Failed to get symbols" }) }],
        };
      }

      const symbols: Array<{
        name: string;
        kind: string;
        line: number;
        column: number;
        children?: Array<{ name: string; kind: string; line: number; column: number }>;
      }> = [];

      function processNode(node: any, parent?: any) {
        if (!node.spans || node.spans.length === 0) return;

        const span = node.spans[0];
        const symbol = {
          name: node.text,
          kind: node.kind,
          line: span.start.line,
          column: span.start.offset,
        };

        // Filter by query if provided
        if (query && !symbol.name.toLowerCase().includes(query.toLowerCase())) {
          // Still process children
          if (node.childItems) {
            for (const child of node.childItems) {
              processNode(child, null);
            }
          }
          return;
        }

        if (parent) {
          if (!parent.children) parent.children = [];
          parent.children.push(symbol);
        } else {
          symbols.push(symbol);
        }

        if (node.childItems) {
          for (const child of node.childItems) {
            processNode(child, symbol);
          }
        }
      }

      if (tree.childItems) {
        for (const child of tree.childItems) {
          processNode(child);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ symbols, count: symbols.length }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: rename
// ============================================================================
server.tool(
  "rename",
  "Preview renaming a symbol at a specific position (shows all locations that would be renamed)",
  {
    file: z.string().describe("Absolute path to the .vue file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    newName: z.string().describe("New name for the symbol"),
  },
  async ({ file, line, column, newName }) => {
    try {
      const locations = await getRenameLocations(file, line, column);
      if (!locations || locations.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Cannot rename symbol at this position" }) }],
        };
      }

      const changes: Record<string, Array<{ line: number; column: number; length: number }>> = {};

      for (const loc of locations) {
        if (!changes[loc.file]) {
          changes[loc.file] = [];
        }
        changes[loc.file].push({
          line: loc.line,
          column: loc.column,
          length: loc.length,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            preview: true,
            newName,
            changes,
            totalLocations: locations.length,
            filesAffected: Object.keys(changes).length,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: search
// ============================================================================
server.tool(
  "search",
  "Search for a pattern in Vue files using ripgrep",
  {
    pattern: z.string().describe("The regex pattern to search for"),
    path: z.string().optional().describe("Directory or file to search in"),
    glob: z.string().optional().describe("Glob pattern to filter files (e.g., '*.vue')"),
    caseSensitive: z.boolean().default(true).describe("Whether the search is case sensitive"),
    maxResults: z.number().int().positive().default(50).describe("Maximum number of results"),
  },
  async ({ pattern, path: searchPath, glob, caseSensitive, maxResults }) => {
    try {
      const { execSync } = await import("child_process");

      const args = ["rg", "--json", "-n"];
      if (!caseSensitive) args.push("-i");
      if (glob) {
        args.push("-g", glob);
      } else {
        // Default to Vue files
        args.push("-g", "*.vue");
      }
      args.push("--max-count", maxResults.toString());
      args.push(pattern);
      if (searchPath) args.push(searchPath);

      const result = execSync(args.join(" "), {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const matches: Array<{
        file: string;
        line: number;
        column: number;
        text: string;
      }> = [];

      for (const line of result.split("\n")) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.type === "match") {
            matches.push({
              file: json.data.path.text,
              line: json.data.line_number,
              column: json.data.submatches[0]?.start + 1 || 1,
              text: json.data.lines.text.trim(),
            });
          }
        } catch {
          // Ignore parse errors
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ matches, count: matches.length }),
        }],
      };
    } catch (error: any) {
      if (error.status === 1) {
        // No matches found
        return {
          content: [{ type: "text", text: JSON.stringify({ matches: [], count: 0 }) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Tool: status
// ============================================================================
server.tool(
  "status",
  "Check Vue Language Server status for a project",
  {
    file: z.string().describe("A .vue file path to check the project status for"),
  },
  async ({ file }) => {
    try {
      const status = await getProjectStatus(file);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(status),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ============================================================================
// Main
// ============================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Vue LSP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
