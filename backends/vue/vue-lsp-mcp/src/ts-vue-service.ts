/**
 * Direct TypeScript Server Service for Vue files
 *
 * Uses tsserver directly with @vue/typescript-plugin to provide
 * hover, definition, references for Vue SFCs.
 */

import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";

interface TsServerConnection {
  process: ChildProcess;
  buffer: string;
  seq: number;
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>;
  projectRoot: string;
  openedFiles: Set<string>;
}

const connectionCache = new Map<string, TsServerConnection>();

/**
 * Find project root by looking for package.json or tsconfig.json
 */
function findProjectRoot(filePath: string): string {
  let dir = path.dirname(path.resolve(filePath));
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "tsconfig.json"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(filePath));
}

/**
 * Parse tsserver messages from the buffer
 */
function parseMessages(conn: TsServerConnection): void {
  const lines = conn.buffer.split("\n");
  conn.buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim() || line.startsWith("Content-Length")) continue;

    try {
      const message = JSON.parse(line);
      handleMessage(conn, message);
    } catch {
      // Ignore non-JSON lines
    }
  }
}

/**
 * Handle tsserver message
 */
function handleMessage(conn: TsServerConnection, message: any): void {
  if (message.type === "response" && message.request_seq !== undefined) {
    const pending = conn.pendingRequests.get(message.request_seq);
    if (pending) {
      conn.pendingRequests.delete(message.request_seq);
      if (message.success) {
        pending.resolve(message.body);
      } else {
        pending.reject(new Error(message.message || "Request failed"));
      }
    }
  }
}

/**
 * Send a command to tsserver and wait for response
 */
function sendCommand(conn: TsServerConnection, command: string, args: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const seq = ++conn.seq;
    conn.pendingRequests.set(seq, { resolve, reject });

    const request = { seq, type: "request", command, arguments: args };
    conn.process.stdin?.write(JSON.stringify(request) + "\n");

    // Timeout after 30 seconds
    setTimeout(() => {
      if (conn.pendingRequests.has(seq)) {
        conn.pendingRequests.delete(seq);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

/**
 * Get or create tsserver connection for a project
 */
async function getConnection(projectRoot: string): Promise<TsServerConnection | null> {
  if (connectionCache.has(projectRoot)) {
    return connectionCache.get(projectRoot)!;
  }

  // Find tsserver
  const tsserverPath = path.join(projectRoot, "node_modules", "typescript", "lib", "tsserver.js");
  if (!fs.existsSync(tsserverPath)) {
    console.error("[ts-vue] tsserver not found at:", tsserverPath);
    return null;
  }

  // Find Vue plugin
  const vuePluginPath = path.join(projectRoot, "node_modules", "@vue", "typescript-plugin");
  const hasVuePlugin = fs.existsSync(vuePluginPath);


  const proc = spawn("node", [tsserverPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const conn: TsServerConnection = {
    process: proc,
    buffer: "",
    seq: 0,
    pendingRequests: new Map(),
    projectRoot,
    openedFiles: new Set(),
  };

  proc.stdout?.on("data", (data: Buffer) => {
    conn.buffer += data.toString();
    parseMessages(conn);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.error("[tsserver]", data.toString().trim());
  });

  proc.on("error", (error) => {
    console.error("[tsserver] Error:", error);
    connectionCache.delete(projectRoot);
  });

  proc.on("exit", (code) => {
    console.error(`[tsserver] Exited with code: ${code}`);
    connectionCache.delete(projectRoot);
  });

  connectionCache.set(projectRoot, conn);

  // Configure with Vue plugin
  if (hasVuePlugin) {
    try {
      await sendCommand(conn, "configure", {
        plugins: [{ name: vuePluginPath }],
        preferences: { includePackageJsonAutoImports: "auto" },
      });
    } catch (error) {
      console.error("[ts-vue] Failed to configure:", error);
    }
  }

  return conn;
}

/**
 * Ensure file is open in tsserver
 */
async function ensureFileOpen(conn: TsServerConnection, filePath: string): Promise<void> {
  const absPath = path.resolve(filePath);

  if (conn.openedFiles.has(absPath)) {
    return;
  }

  const content = fs.readFileSync(absPath, "utf-8");

  try {
    await sendCommand(conn, "open", {
      file: absPath,
      fileContent: content,
      scriptKindName: "TS",
      projectRootPath: conn.projectRoot,
    });
    conn.openedFiles.add(absPath);
  } catch (error) {
    console.error("[ts-vue] Failed to open file:", error);
  }
}

/**
 * Get quick info (hover) at a position
 */
export async function getQuickInfo(
  filePath: string,
  line: number,
  column: number
): Promise<{ contents: string; documentation?: string } | null> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return null;

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "quickinfo", {
      file: absPath,
      line,
      offset: column,
    });

    if (!result) return null;

    let contents = result.displayString || "";
    let documentation = result.documentation || "";

    // Add tags if present
    if (result.tags && result.tags.length > 0) {
      const tagTexts = result.tags.map((tag: any) => {
        if (tag.text) {
          return `@${tag.name} ${tag.text}`;
        }
        return `@${tag.name}`;
      });
      if (tagTexts.length > 0) {
        documentation = documentation ? `${documentation}\n\n${tagTexts.join("\n")}` : tagTexts.join("\n");
      }
    }

    return { contents, documentation: documentation || undefined };
  } catch (error) {
    console.error("[ts-vue] quickinfo error:", error);
    return null;
  }
}

/**
 * Parse import path from an import statement line
 */
function parseImportPath(lineContent: string): string | null {
  // Match: import X from 'path' or import X from "path"
  const match = lineContent.match(/from\s+['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * Resolve import path to absolute file path
 */
function resolveImportPath(importPath: string, fromFile: string, projectRoot: string): string | null {
  const fromDir = path.dirname(fromFile);

  // Relative imports
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    // Try with various extensions
    const extensions = ["", ".vue", ".ts", ".tsx", ".js", ".jsx"];
    for (const ext of extensions) {
      const resolved = path.resolve(fromDir, importPath + ext);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
    // Try as directory with index
    const indexExtensions = ["index.ts", "index.js", "index.vue"];
    for (const indexFile of indexExtensions) {
      const resolved = path.resolve(fromDir, importPath, indexFile);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }

  // Node modules imports - resolve from node_modules
  const nodeModulePath = path.join(projectRoot, "node_modules", importPath);
  if (fs.existsSync(nodeModulePath)) {
    // Check for package.json main/types
    const pkgPath = path.join(nodeModulePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const entryPoint = pkg.types || pkg.typings || pkg.main || "index.js";
        const resolved = path.resolve(nodeModulePath, entryPoint);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Get definition locations
 */
export async function getDefinition(
  filePath: string,
  line: number,
  column: number
): Promise<Array<{ file: string; line: number; column: number }>> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return [];

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "definition", {
      file: absPath,
      line,
      offset: column,
    });

    if (!result || !Array.isArray(result)) return [];

    const definitions = result.map((def: any) => ({
      file: def.file,
      line: def.start?.line || 1,
      column: def.start?.offset || 1,
    }));

    // Check if definition points back to same file (likely an import statement)
    if (definitions.length > 0 && definitions[0].file === absPath) {
      const defLine = definitions[0].line;

      // Read the file and check if it's an import line
      const content = fs.readFileSync(absPath, "utf-8");
      const lines = content.split("\n");
      if (defLine > 0 && defLine <= lines.length) {
        const lineContent = lines[defLine - 1];

        // Check if this is an import statement
        if (lineContent.trim().startsWith("import ")) {
          const importPath = parseImportPath(lineContent);
          if (importPath) {
            const resolvedPath = resolveImportPath(importPath, absPath, projectRoot);
            if (resolvedPath) {
              // Return the resolved import target
              return [{ file: resolvedPath, line: 1, column: 1 }];
            }
          }
        }
      }
    }

    return definitions;
  } catch (error) {
    console.error("[ts-vue] definition error:", error);
    return [];
  }
}

/**
 * Get references to a symbol
 */
export async function getReferences(
  filePath: string,
  line: number,
  column: number
): Promise<Array<{ file: string; line: number; column: number }>> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return [];

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "references", {
      file: absPath,
      line,
      offset: column,
    });

    if (!result || !result.refs) return [];

    return result.refs.map((ref: any) => ({
      file: ref.file,
      line: ref.start?.line || 1,
      column: ref.start?.offset || 1,
    }));
  } catch (error) {
    console.error("[ts-vue] references error:", error);
    return [];
  }
}

/**
 * Get completions at a position
 */
export async function getCompletions(
  filePath: string,
  line: number,
  column: number,
  limit: number = 20
): Promise<{ items: Array<{ name: string; kind: string }>; isIncomplete: boolean }> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return { items: [], isIncomplete: false };

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "completions", {
      file: absPath,
      line,
      offset: column,
      includeExternalModuleExports: true,
      includeInsertTextCompletions: true,
    });

    if (!result || !Array.isArray(result)) return { items: [], isIncomplete: false };

    const items = result.slice(0, limit).map((entry: any) => ({
      name: entry.name,
      kind: entry.kind || "unknown",
    }));

    return {
      items,
      isIncomplete: result.length > limit,
    };
  } catch (error) {
    console.error("[ts-vue] completions error:", error);
    return { items: [], isIncomplete: false };
  }
}

/**
 * Get signature help at a position
 */
export async function getSignatureHelp(
  filePath: string,
  line: number,
  column: number
): Promise<{
  signatures: Array<{ label: string; documentation?: string; parameters?: Array<{ label: string; documentation?: string }> }>;
  activeSignature: number;
  activeParameter: number;
} | null> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return null;

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "signatureHelp", {
      file: absPath,
      line,
      offset: column,
    });

    if (!result || !result.items || result.items.length === 0) {
      return null;
    }

    const signatures = result.items.map((item: any) => {
      // Build the signature label from prefix, parameters, and suffix
      const params = item.parameters || [];
      const paramLabels = params.map((p: any) => p.displayParts?.map((d: any) => d.text).join("") || "").join(", ");
      const prefix = item.prefixDisplayParts?.map((d: any) => d.text).join("") || "";
      const suffix = item.suffixDisplayParts?.map((d: any) => d.text).join("") || "";
      const label = `${prefix}${paramLabels}${suffix}`;

      // Extract documentation
      const documentation = item.documentation?.map((d: any) => d.text).join("") || undefined;

      // Extract parameter info
      const parameters = params.map((p: any) => ({
        label: p.displayParts?.map((d: any) => d.text).join("") || "",
        documentation: p.documentation?.map((d: any) => d.text).join("") || undefined,
      }));

      return { label, documentation, parameters };
    });

    return {
      signatures,
      activeSignature: result.selectedItemIndex || 0,
      activeParameter: result.argumentIndex || 0,
    };
  } catch (error) {
    console.error("[ts-vue] signatureHelp error:", error);
    return null;
  }
}

/**
 * Get document symbols (navigation tree)
 */
export async function getDocumentSymbols(
  filePath: string
): Promise<any | null> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return null;

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "navtree", {
      file: absPath,
    });

    return result;
  } catch (error) {
    console.error("[ts-vue] navtree error:", error);
    return null;
  }
}

/**
 * Get rename locations for a symbol
 */
export async function getRenameLocations(
  filePath: string,
  line: number,
  column: number
): Promise<Array<{
  file: string;
  line: number;
  column: number;
  length: number;
}> | null> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  if (!conn) return null;

  const absPath = path.resolve(filePath);
  await ensureFileOpen(conn, absPath);

  try {
    const result = await sendCommand(conn, "rename", {
      file: absPath,
      line,
      offset: column,
      findInComments: false,
      findInStrings: false,
    });

    if (!result || !result.locs) {
      return null;
    }

    const locations: Array<{
      file: string;
      line: number;
      column: number;
      length: number;
    }> = [];

    for (const loc of result.locs) {
      for (const span of loc.locs || []) {
        locations.push({
          file: loc.file,
          line: span.start.line,
          column: span.start.offset,
          length: span.end.offset - span.start.offset,
        });
      }
    }

    return locations;
  } catch (error) {
    console.error("[ts-vue] rename error:", error);
    return null;
  }
}
