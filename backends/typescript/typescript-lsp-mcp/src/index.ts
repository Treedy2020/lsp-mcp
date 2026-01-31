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
import { createRequire } from "module";

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
  getApplicableRefactors,
  getRefactorEdits,
  getFunctionSignature,
  applyFileChanges,
  getProjectConfig,
  setActiveWorkspace,
  validateFileWorkspace,
  resolveFilePath,
  clearAllCaches,
  getCombinedCodeActions,
  applyQuickFix,
  getInlayHints,
} from "./ts-service.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Create MCP server
const server = new McpServer({
  name: "typescript-lsp-mcp",
  version: packageJson.version,
});

// ============================================================================
// Tool: inlay_hints
// ============================================================================
server.tool(
  "inlay_hints",
  "Get inlay hints (type annotations, parameter names) for a file",
  {
    file: z.string().describe("Path to the file"),
  },
  async ({ file }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const hints = getInlayHints(absPath);
      
      // Transform to a simpler format similar to LSP
      const result = hints.map((h: any) => ({
        label: h.text, // TS InlayHintLabelPart | string
        position: offsetToPosition(getFileContent(absPath), h.position),
        kind: h.kind,
        paddingLeft: h.paddingLeft,
        paddingRight: h.paddingRight
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ hints: result, count: result.length }),
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
// Tool: code_action
// ============================================================================
server.tool(
  "code_action",
  "Get available code actions (refactors and quick fixes) at a specific position",
  {
    file: z.string().describe("Path to the file"),
    line: z.number().int().positive().describe("Line number"),
    column: z.number().int().positive().describe("Column number"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const actions = getCombinedCodeActions(absPath, line, column);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ actions, count: actions.length }),
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
// Tool: run_code_action
// ============================================================================
server.tool(
  "run_code_action",
  "Apply a code action (refactor or quick fix)",
  {
    file: z.string().describe("Path to the file"),
    line: z.number().int().positive().describe("Line number"),
    column: z.number().int().positive().describe("Column number"),
    kind: z.enum(["refactor", "quickfix"]).describe("Kind of action"),
    name: z.string().describe("Name of the refactor or fix"),
    actionName: z.string().optional().describe("Action name (required for refactors)"),
    preview: z.boolean().default(false).describe("If true, only show what would change"),
  },
  async ({ file, line, column, kind, name, actionName, preview }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      let changes;
      
      if (kind === "refactor") {
        if (!actionName) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "actionName is required for refactors" }) }] };
        }
        const edits = getRefactorEdits(absPath, line, column, name, actionName);
        changes = edits?.edits;
      } else {
        // Quick Fix
        changes = applyQuickFix(absPath, line, column, name);
      }

      if (!changes || changes.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No changes generated" }) }],
        };
      }

      if (preview) {
        const previewChanges = changes.map((edit) => ({
          file: edit.fileName,
          isNewFile: edit.isNewFile,
          changes: edit.textChanges.length,
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ preview: true, changes: previewChanges }),
          }],
        };
      }

      const result = applyFileChanges(changes);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ...result }),
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
// Tool: switch_workspace
// ============================================================================
server.tool(
  "switch_workspace",
  "Switch the active workspace to a new project directory",
  {
    path: z.string().describe("Absolute path to the new project root directory"),
  },
  async ({ path: inputPath }) => {
    try {
      const absPath = path.resolve(inputPath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid Path", message: `'${inputPath}' is not a directory.` }) }],
        };
      }

      // Clear all caches
      clearAllCaches();

      // Set new active workspace
      const newWorkspace = setActiveWorkspace(absPath);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Switched active workspace to: ${newWorkspace}`,
            workspace: newWorkspace,
            info: "All previous TypeScript caches have been cleared.",
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
// Tool: hover
// ============================================================================
server.tool(
  "hover",
  "Get type information and documentation at a specific position in a TypeScript/JavaScript file",
  {
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const info = getQuickInfo(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const definitions = getDefinition(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const refs = getReferences(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    limit: z.number().int().positive().default(20).describe("Maximum number of completions to return"),
  },
  async ({ file, line, column, limit }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const completions = getCompletions(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const help = getSignatureHelp(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    query: z.string().optional().describe("Optional filter query for symbol names"),
  },
  async ({ file, query }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const tree = getDocumentSymbols(absPath);

      const symbols: Array<{
        name: string;
        kind: string;
        line: number;
        column: number;
        children?: Array<{ name: string; kind: string; line: number; column: number }>;
      }> = [];

      const content = getFileContent(absPath);

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
    path: z.string().describe("Path to a file or directory to check (absolute or relative to active workspace)"),
  },
  async ({ path: inputPath }) => {
    try {
      const { absPath, error } = resolveFilePath(inputPath);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    newName: z.string().describe("New name for the symbol"),
  },
  async ({ file, line, column, newName }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const locations = getRenameLocations(absPath, line, column);
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
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    content: z.string().describe("New content for the file"),
  },
  async ({ file, content }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      updateDocument(absPath, content);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, file: absPath }),
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
  "Check TypeScript environment status for a project. Shows parsed config and any errors.",
  {
    file: z.string().describe("A TypeScript/JavaScript file path to check the project status for (absolute or relative to active workspace)"),
  },
  async ({ file }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const projectRoot = findProjectRoot(absPath);
      const configPath = path.join(projectRoot, "tsconfig.json");

      const hasConfig = fs.existsSync(configPath);

      // Get the parsed config (this triggers parsing if not cached)
      const parsedConfig = getProjectConfig(projectRoot);

      // Check node_modules for type packages
      const nodeModulesPath = path.join(projectRoot, "node_modules");
      const availableTypes: string[] = [];
      if (fs.existsSync(nodeModulesPath)) {
        // Check for common type packages
        const typePackages = [
          "vite/client.d.ts",
          "@types/node",
          "@vue/runtime-dom",
        ];
        for (const pkg of typePackages) {
          if (fs.existsSync(path.join(nodeModulesPath, pkg))) {
            availableTypes.push(pkg.replace("/client.d.ts", "/client"));
          }
        }
      }

      // Summarize key compiler options
      const keyOptions: Record<string, any> = {};
      if (parsedConfig?.options) {
        const opts = parsedConfig.options;
        keyOptions.target = opts.target;
        keyOptions.module = opts.module;
        keyOptions.moduleResolution = opts.moduleResolution;
        keyOptions.types = opts.types;
        keyOptions.typeRoots = opts.typeRoots;
        keyOptions.strict = opts.strict;
        keyOptions.baseUrl = opts.baseUrl;
        keyOptions.paths = opts.paths;
        // JSX configuration
        keyOptions.jsx = opts.jsx;
        keyOptions.jsxFactory = opts.jsxFactory;
        keyOptions.jsxFragmentFactory = opts.jsxFragmentFactory;
        keyOptions.jsxImportSource = opts.jsxImportSource;
      }

      // Get declaration files found
      const declarationFiles = parsedConfig?.declarationFiles || [];
      const detectedFrameworks = parsedConfig?.detectedFrameworks || [];

      // Build tips based on detected configuration
      const tips: string[] = [];
      if (detectedFrameworks.includes("vite") && !keyOptions.types?.includes("vite/client")) {
        tips.push("Add 'vite/client' to compilerOptions.types in tsconfig.json for import.meta.env support");
      }
      if (detectedFrameworks.includes("vue")) {
        tips.push("Vue SFC (.vue files) require vue-tsc for full type checking. This LSP handles .ts/.tsx files.");
      }
      // Check for Vue TSX configuration
      if (detectedFrameworks.includes("vue-tsx") || detectedFrameworks.includes("vue")) {
        if (!keyOptions.jsx) {
          tips.push("For Vue TSX: add 'jsx': 'preserve' to compilerOptions");
        }
        if (!keyOptions.jsxImportSource && keyOptions.jsx) {
          tips.push("For Vue 3.3+ TSX: add 'jsxImportSource': 'vue' to compilerOptions for automatic JSX transform");
        }
      }
      if (detectedFrameworks.includes("vue-tsx")) {
        if (keyOptions.jsxImportSource === "vue") {
          tips.push("Vue TSX is properly configured with jsxImportSource: 'vue'");
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            projectRoot,
            hasConfig,
            configPath: hasConfig ? configPath : null,
            typescript: {
              version: parsedConfig?.typescriptVersion || require("typescript").version,
              source: parsedConfig?.typescriptSource || "bundled",
            },
            detectedFrameworks: detectedFrameworks.length > 0 ? detectedFrameworks : undefined,
            availableTypes: availableTypes.length > 0 ? availableTypes : undefined,
            parsedOptions: keyOptions,
            configErrors: parsedConfig?.errors?.length ? parsedConfig.errors : undefined,
            filesIncluded: parsedConfig?.fileNames?.length || 0,
            declarationFiles: declarationFiles.length > 0 ? {
              count: declarationFiles.length,
              files: declarationFiles.map(f => path.relative(projectRoot, f)),
            } : undefined,
            tips: tips.length > 0 ? tips : undefined,
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
    path: z.string().optional().describe("Directory or file to search in (absolute or relative to active workspace)"),
    glob: z.string().optional().describe("Glob pattern to filter files (e.g., '*.ts')"),
    caseSensitive: z.boolean().default(true).describe("Whether the search is case sensitive"),
    maxResults: z.number().int().positive().default(50).describe("Maximum number of results"),
  },
  async ({ pattern, path: searchPath, glob, caseSensitive, maxResults }) => {
    try {
      let absSearchPath: string | undefined;
      
      if (searchPath) {
        const { absPath, error } = resolveFilePath(searchPath);
        if (error || !absPath) {
          return { content: [{ type: "text", text: error || "Invalid path" }] };
        }
        absSearchPath = absPath;
      } else {
        // Default to active workspace if set
        const active = import("./ts-service.js").then(m => m.getActiveWorkspace()); // Dynamic import to avoid circular dependency issues if any, though here it's fine
        // Actually we can just use the function we imported
        // But getActiveWorkspace is synchronous
        // Let's just use what we have
        // But we need to check if we have an active workspace
        // We can't access activeWorkspace variable directly as it is not exported, use getter
        // Wait, we imported resolveFilePath, let's use a helper or modify logic
        // We can use resolveFilePath(".") to get the workspace root if set
        const { absPath } = resolveFilePath(".");
        // If we are in a workspace, absPath will be the workspace root
        // If not, it will be cwd. 
        // This is fine for search default.
        if (absPath) absSearchPath = absPath;
      }

      const { execSync } = await import("child_process");

      const args = ["rg", "--json", "-n"];
      if (!caseSensitive) args.push("-i");
      if (glob) args.push("-g", glob);
      args.push("--max-count", maxResults.toString());
      args.push(pattern);
      if (absSearchPath) args.push(absSearchPath);

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
// Tool: move
// ============================================================================
server.tool(
  "move",
  "Move a function, class, or variable to a new file. Uses TypeScript's 'Move to a new file' refactoring.",
  {
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    destination: z.string().optional().describe("Destination file path (optional, TypeScript will generate a name if not provided)"),
    preview: z.boolean().default(false).describe("If true, only show what would change"),
  },
  async ({ file, line, column, destination, preview }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      // Get available refactorings
      const refactors = getApplicableRefactors(absPath, line, column);

      // Look for "Move to a new file" refactoring
      const moveRefactor = refactors.find(
        (r) => r.name === "Move to a new file" || r.actions.some((a) => a.name.includes("Move"))
      );

      if (!moveRefactor) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Cannot move symbol at this position",
              available: refactors.map((r) => ({
                name: r.name,
                actions: r.actions.map((a) => a.name),
              })),
            }),
          }],
        };
      }

      // Find the move action
      const moveAction = moveRefactor.actions.find((a) => a.name.includes("Move")) || moveRefactor.actions[0];

      // Get the edits
      const edits = getRefactorEdits(absPath, line, column, moveRefactor.name, moveAction.name);

      if (!edits || !edits.edits.length) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No edits generated for move" }) }],
        };
      }

      if (preview) {
        // Just show what would change
        const changes = edits.edits.map((edit) => ({
          file: edit.fileName,
          isNewFile: edit.isNewFile,
          changes: edit.textChanges.length,
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              preview: true,
              action: moveAction.name,
              changes,
            }),
          }],
        };
      }

      // Apply the changes
      const result = applyFileChanges(edits.edits);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            action: moveAction.name,
            ...result,
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
// Tool: function_signature
// ============================================================================
server.tool(
  "function_signature",
  "Get the current signature of a function at a specific position",
  {
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const signature = getFunctionSignature(absPath, line, column);

      if (!signature) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No function found at this position" }) }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(signature),
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
// Tool: available_refactors
// ============================================================================
server.tool(
  "available_refactors",
  "Get available refactoring actions at a specific position",
  {
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
  },
  async ({ file, line, column }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const refactors = getApplicableRefactors(absPath, line, column);

      const result = refactors.map((r) => ({
        name: r.name,
        description: r.description,
        actions: r.actions.map((a) => ({
          name: a.name,
          description: a.description,
        })),
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ refactors: result, count: result.length }),
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
// Tool: apply_refactor
// ============================================================================
server.tool(
  "apply_refactor",
  "Apply a specific refactoring action at a position",
  {
    file: z.string().describe("Path to the file (absolute or relative to active workspace)"),
    line: z.number().int().positive().describe("Line number (1-based)"),
    column: z.number().int().positive().describe("Column number (1-based)"),
    refactorName: z.string().describe("Name of the refactoring (from available_refactors)"),
    actionName: z.string().describe("Name of the action (from available_refactors)"),
    preview: z.boolean().default(false).describe("If true, only show what would change"),
  },
  async ({ file, line, column, refactorName, actionName, preview }) => {
    try {
      const { absPath, error } = resolveFilePath(file);
      if (error || !absPath) {
        return { content: [{ type: "text", text: error || "Invalid path" }] };
      }

      const edits = getRefactorEdits(absPath, line, column, refactorName, actionName);

      if (!edits || !edits.edits.length) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No edits generated" }) }],
        };
      }

      if (preview) {
        const changes = edits.edits.map((edit) => ({
          file: edit.fileName,
          isNewFile: edit.isNewFile,
          changes: edit.textChanges.length,
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ preview: true, changes }),
          }],
        };
      }

      const result = applyFileChanges(edits.edits);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, ...result }),
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
  console.error("TypeScript LSP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
