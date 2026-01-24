#!/usr/bin/env node
/**
 * TypeScript LSP MCP Server
 *
 * MCP server providing TypeScript/JavaScript code intelligence
 * using the official TypeScript Language Service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs";

import {
  findProjectRoot,
  getQuickInfo,
  getDefinition,
  getReferences,
  getCompletions,
  getSignatureHelp,
  getDocumentSymbols,
  getDiagnostics,
  getRenameLocations,
  updateDocument,
  getFileContent,
  offsetToPosition,
  displayPartsToString,
  formatDiagnostic,
} from "./ts-service.js";

// Create MCP server
const server = new McpServer({
  name: "typescript-lsp-mcp",
  version: "0.1.0",
});

// ============================================================================
// Tool: hover
// ============================================================================
server.tool(
  "hover",
  "Get type information and documentation at a specific position in a TypeScript/JavaScript file",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const info = getQuickInfo(file, line, column);
      if (!info) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No information available at this position" }) }],
        };
      }

      const displayString = displayPartsToString(info.displayParts);
      const documentation = displayPartsToString(info.documentation);
      const tags = info.tags?.map((tag) => ({
        name: tag.name,
        text: displayPartsToString(tag.text),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            contents: displayString,
            documentation: documentation || undefined,
            tags: tags?.length ? tags : undefined,
            kind: info.kind,
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
// Tool: definition
// ============================================================================
server.tool(
  "definition",
  "Go to definition of a symbol at a specific position",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const definitions = getDefinition(file, line, column);
      if (!definitions || definitions.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No definition found" }) }],
        };
      }

      const result = definitions.map((def) => {
        const content = getFileContent(def.fileName);
        const start = offsetToPosition(content, def.textSpan.start);
        const end = offsetToPosition(content, def.textSpan.start + def.textSpan.length);
        return {
          file: def.fileName,
          line: start.line,
          column: start.column,
          endLine: end.line,
          endColumn: end.column,
          kind: def.kind,
          name: def.name,
        };
      });

      // Return single definition or array
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.length === 1 ? result[0] : result),
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
  "Find all references to a symbol at a specific position",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const refs = getReferences(file, line, column);
      if (!refs || refs.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ references: [], count: 0 }) }],
        };
      }

      const references = refs.map((ref) => {
        const content = getFileContent(ref.fileName);
        const start = offsetToPosition(content, ref.textSpan.start);
        return {
          file: ref.fileName,
          line: start.line,
          column: start.column,
          isWriteAccess: ref.isWriteAccess,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ references, count: references.length }),
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
  "Get code completion suggestions at a specific position",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    limit: z.number().int().positive().default(20).describe("Maximum number of completions to return"),
  },
  async ({ file, line, column, limit }) => {
    try {
      const completions = getCompletions(file, line, column);
      if (!completions) {
        return {
          content: [{ type: "text", text: JSON.stringify({ completions: [], count: 0 }) }],
        };
      }

      const items = completions.entries.slice(0, limit).map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        sortText: entry.sortText,
        insertText: entry.insertText,
        isRecommended: entry.isRecommended,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            completions: items,
            count: items.length,
            isIncomplete: completions.entries.length > limit,
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
  "Get function signature help at a specific position",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const help = getSignatureHelp(file, line, column);
      if (!help) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No signature help available" }) }],
        };
      }

      const signatures = help.items.map((item) => ({
        label: displayPartsToString(item.prefixDisplayParts) +
          item.parameters.map((p) => displayPartsToString(p.displayParts)).join(", ") +
          displayPartsToString(item.suffixDisplayParts),
        documentation: displayPartsToString(item.documentation),
        parameters: item.parameters.map((p) => ({
          name: p.name,
          label: displayPartsToString(p.displayParts),
          documentation: displayPartsToString(p.documentation),
        })),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            signatures,
            activeSignature: help.selectedItemIndex,
            activeParameter: help.argumentIndex,
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
// Tool: symbols
// ============================================================================
server.tool(
  "symbols",
  "Extract symbols (classes, functions, methods, variables) from a file",
  {
    file: z.string().describe("Absolute path to the file"),
    query: z.string().optional().describe("Optional filter query for symbol names"),
  },
  async ({ file, query }) => {
    try {
      const tree = getDocumentSymbols(file);

      const symbols: Array<{
        name: string;
        kind: string;
        line: number;
        column: number;
        children?: Array<{ name: string; kind: string; line: number; column: number }>;
      }> = [];

      const content = getFileContent(file);

      function processNode(node: any, parent?: any) {
        if (!node.nameSpan) return;

        const pos = offsetToPosition(content, node.nameSpan.start);
        const symbol = {
          name: node.text,
          kind: node.kind,
          line: pos.line,
          column: pos.column,
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
// Tool: diagnostics
// ============================================================================
server.tool(
  "diagnostics",
  "Get type errors and warnings for a TypeScript/JavaScript file",
  {
    path: z.string().describe("Path to a file or directory to check"),
  },
  async ({ path: inputPath }) => {
    try {
      const absPath = path.resolve(inputPath);
      const stats = fs.statSync(absPath);

      let files: string[] = [];
      if (stats.isDirectory()) {
        // Find all TS/JS files in directory
        const walkDir = (dir: string): string[] => {
          const results: string[] = [];
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
              results.push(...walkDir(fullPath));
            } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
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
        const diags = getDiagnostics(file);
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
// Tool: rename
// ============================================================================
server.tool(
  "rename",
  "Preview renaming a symbol at a specific position (shows all locations that would be renamed)",
  {
    file: z.string().describe("Absolute path to the file"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    newName: z.string().describe("New name for the symbol"),
  },
  async ({ file, line, column, newName }) => {
    try {
      const locations = getRenameLocations(file, line, column);
      if (!locations || locations.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Cannot rename symbol at this position" }) }],
        };
      }

      const changes: Record<string, Array<{ line: number; column: number; oldText: string }>> = {};

      for (const loc of locations) {
        const content = getFileContent(loc.fileName);
        const pos = offsetToPosition(content, loc.textSpan.start);
        const oldText = content.substring(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length);

        if (!changes[loc.fileName]) {
          changes[loc.fileName] = [];
        }
        changes[loc.fileName].push({
          line: pos.line,
          column: pos.column,
          oldText,
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
// Tool: update_document
// ============================================================================
server.tool(
  "update_document",
  "Update file content for incremental analysis without writing to disk",
  {
    file: z.string().describe("Absolute path to the file"),
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
// Tool: status
// ============================================================================
server.tool(
  "status",
  "Check TypeScript environment status for a project",
  {
    file: z.string().describe("A TypeScript/JavaScript file path to check the project status for"),
  },
  async ({ file }) => {
    try {
      const absPath = path.resolve(file);
      const projectRoot = findProjectRoot(absPath);
      const configPath = path.join(projectRoot, "tsconfig.json");

      const hasConfig = fs.existsSync(configPath);
      let compilerOptions: Record<string, any> = {};

      if (hasConfig) {
        const configFile = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        compilerOptions = configFile.compilerOptions || {};
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            projectRoot,
            hasConfig,
            configPath: hasConfig ? configPath : null,
            typescript: {
              version: require("typescript").version,
            },
            compilerOptions: hasConfig ? compilerOptions : "default",
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
  "Search for a pattern in files using ripgrep",
  {
    pattern: z.string().describe("The regex pattern to search for"),
    path: z.string().optional().describe("Directory or file to search in"),
    glob: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
    caseSensitive: z.boolean().default(true).describe("Whether the search is case sensitive"),
    maxResults: z.number().int().positive().default(50).describe("Maximum number of results"),
  },
  async ({ pattern, path: searchPath, glob, caseSensitive, maxResults }) => {
    try {
      const { execSync } = await import("child_process");

      const args = ["rg", "--json", "-n"];
      if (!caseSensitive) args.push("-i");
      if (glob) args.push("-g", glob);
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
// Main
// ============================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TypeScript LSP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
