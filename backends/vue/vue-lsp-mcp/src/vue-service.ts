/**
 * Vue Language Service wrapper
 *
 * Provides programmatic access to Vue Language Server features
 * by spawning vue-language-server and communicating via LSP.
 */

import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { createRequire } from "module";

// Document content cache
const documentContents = new Map<string, string>();
const documentVersions = new Map<string, number>();

// LSP message ID counter
let messageId = 0;

// Track active connections for cleanup
const activeConnections = new Set<LspConnection>();

// Cleanup on exit
process.on('exit', () => {
  for (const conn of activeConnections) {
    try {
      conn.process.kill();
      if (conn.tsserver) conn.tsserver.kill();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
});

// Diagnostic from LSP
interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  code?: string | number;
  source?: string;
}

// LSP server connection per project
interface LspConnection {
  process: ChildProcess;
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>;
  initialized: boolean;
  buffer: string;
  diagnosticsCache: Map<string, LspDiagnostic[]>;
  openedDocuments: Set<string>;
  projectRoot: string;
  // TypeScript server for Volar 3.x hybrid mode support
  tsserver?: ChildProcess;
  tsserverBuffer?: string;
  tsserverSeq?: number;
  tsserverPendingRequests?: Map<number, { volarId: number; resolve: (value: any) => void }>;
}

const connectionCache = new Map<string, LspConnection>();

/**
 * Spawn and initialize tsserver for Volar 3.x support
 */
function spawnTsServer(conn: LspConnection): void {
  if (conn.tsserver) return;

  const projectRoot = conn.projectRoot;
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));

  // Find tsserver path
  let tsserverPath: string | null = null;
  try {
    const typescriptPath = projectRequire.resolve("typescript");
    tsserverPath = path.join(path.dirname(typescriptPath), "tsserver.js");
  } catch (e) {
    // Fallback to searching node_modules manually if resolve fails
    const commonPaths = [
      path.join(projectRoot, "node_modules", "typescript", "lib", "tsserver.js"),
      path.join(projectRoot, "node_modules", ".bin", "tsserver"),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        tsserverPath = p;
        break;
      }
    }
  }

  if (!tsserverPath || !fs.existsSync(tsserverPath)) {
    console.error("[DEBUG] tsserver not found, Volar 3.x features may not work");
    return;
  }

  // Find Vue TypeScript plugin
  let vuePluginPath: string | null = null;
  try {
    // Try newer @vue/typescript-plugin
    try {
        const pkgPath = projectRequire.resolve("@vue/typescript-plugin/package.json");
        vuePluginPath = path.dirname(pkgPath);
    } catch {
        // Try older path or other variations
        const langCorePath = projectRequire.resolve("@vue/language-core");
        // Usually plugins are configured differently in newer versions, 
        // but let's try to find a valid plugin entry.
        // For simplicity in this fix, we stick to checking existence if resolve fails or returns unexpected.
         const commonPluginPaths = [
            path.join(projectRoot, "node_modules", "@vue", "typescript-plugin"),
            path.join(projectRoot, "node_modules", "@vue", "language-core", "dist", "languagePlugin.js"),
        ];
        for (const p of commonPluginPaths) {
            if (fs.existsSync(p)) {
                vuePluginPath = p;
                break;
            }
        }
    }
  } catch (e) {
      // Ignore
  }


  // Build plugin config if Vue plugin is available
  const plugins = vuePluginPath ? [{ name: vuePluginPath }] : [];

  conn.tsserver = spawn("node", [tsserverPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TSS_LOG: "-level verbose",
    },
  });

  conn.tsserverBuffer = "";
  conn.tsserverSeq = 0;
  conn.tsserverPendingRequests = new Map();

  conn.tsserver.stdout?.on("data", (data: Buffer) => {
    conn.tsserverBuffer! += data.toString();
    parseTsServerMessages(conn);
  });

  conn.tsserver.stderr?.on("data", (data: Buffer) => {
    // console.error("[tsserver]", data.toString().trim());
  });

  conn.tsserver.on("error", (error) => {
    console.error("[tsserver] Error:", error);
  });

  conn.tsserver.on("exit", (code) => {
    conn.tsserver = undefined;
  });

  // Configure tsserver with the Vue plugin
  const seq = ++conn.tsserverSeq!;
  const configRequest = {
    seq,
    type: "request",
    command: "configure",
    arguments: {
      plugins,
      preferences: {
        includePackageJsonAutoImports: "auto",
      },
    },
  };
  const configContent = JSON.stringify(configRequest) + "\n";
  conn.tsserver.stdin?.write(configContent);

  // Open the project
  const projectInfoSeq = ++conn.tsserverSeq!;
  const openProjectRequest = {
    seq: projectInfoSeq,
    type: "request",
    command: "open",
    arguments: {
      file: path.join(projectRoot, "src", "main.ts"),
      projectRootPath: projectRoot,
    },
  };

  // Check if main.ts exists, otherwise try main.js
  const mainTs = path.join(projectRoot, "src", "main.ts");
  const mainJs = path.join(projectRoot, "src", "main.js");
  const indexVue = path.join(projectRoot, "src", "App.vue");
  let openFile = mainTs;
  if (!fs.existsSync(mainTs)) {
    if (fs.existsSync(mainJs)) openFile = mainJs;
    else if (fs.existsSync(indexVue)) openFile = indexVue;
  }

  if (fs.existsSync(openFile)) {
    openProjectRequest.arguments.file = openFile;
    const openContent = JSON.stringify(openProjectRequest) + "\n";
    conn.tsserver.stdin?.write(openContent);
  }
}

/**
 * Parse tsserver messages from the buffer
 */
function parseTsServerMessages(conn: LspConnection): void {
  const lines = conn.tsserverBuffer!.split("\n");
  conn.tsserverBuffer = lines.pop() || ""; // Keep incomplete line

  for (const line of lines) {
    if (!line.trim() || line.startsWith("Content-Length")) continue;

    try {
      const message = JSON.parse(line);
      handleTsServerMessage(conn, message);
    } catch {
      // Ignore non-JSON lines
    }
  }
}

/**
 * Handle tsserver response message
 */
function handleTsServerMessage(conn: LspConnection, message: any): void {
  if (message.type === "response" && message.request_seq !== undefined) {
    const pending = conn.tsserverPendingRequests?.get(message.request_seq);
    if (pending) {
      conn.tsserverPendingRequests!.delete(message.request_seq);
      pending.resolve(message.body);

      // Send response back to Volar
      const responseNotification = JSON.stringify({
        jsonrpc: "2.0",
        method: "tsserver/response",
        params: [[pending.volarId, message.body]],
      });
      const responseContent = `Content-Length: ${Buffer.byteLength(responseNotification)}\r\n\r\n${responseNotification}`;
      conn.process.stdin?.write(responseContent);
    }
  }
}

/**
 * Forward a tsserver request command
 */
function forwardToTsServer(conn: LspConnection, volarId: number, command: string, args: any): void {
  if (!conn.tsserver) {
    spawnTsServer(conn);
    if (!conn.tsserver) {
      // Still no tsserver, send null response
      const responseNotification = JSON.stringify({
        jsonrpc: "2.0",
        method: "tsserver/response",
        params: [[volarId, null]],
      });
      const responseContent = `Content-Length: ${Buffer.byteLength(responseNotification)}\r\n\r\n${responseNotification}`;
      conn.process.stdin?.write(responseContent);
      return;
    }
  }

  // Strip _vue: prefix and send to tsserver
  const tsCommand = command.replace(/^_vue:/, "");
  const seq = ++conn.tsserverSeq!;

  // Store mapping from tsserver seq to volar id
  conn.tsserverPendingRequests!.set(seq, {
    volarId,
    resolve: () => {}, // Will be called when response comes
  });

  const request = {
    seq,
    type: "request",
    command: tsCommand,
    arguments: args,
  };

  const content = JSON.stringify(request) + "\n";
  conn.tsserver.stdin?.write(content);

  // Timeout after 30 seconds
  setTimeout(() => {
    if (conn.tsserverPendingRequests?.has(seq)) {
      conn.tsserverPendingRequests.delete(seq);
      // Send null response to Volar
      const responseNotification = JSON.stringify({
        jsonrpc: "2.0",
        method: "tsserver/response",
        params: [[volarId, null]],
      });
      const responseContent = `Content-Length: ${Buffer.byteLength(responseNotification)}\r\n\r\n${responseNotification}`;
      conn.process.stdin?.write(responseContent);
    }
  }, 30000);
}

// Active workspace for single-project mode
let activeWorkspace: string | null = null;

/**
 * Set the active workspace.
 */
export function setActiveWorkspace(workspace: string): string {
  activeWorkspace = path.resolve(workspace);
  return activeWorkspace;
}

/**
 * Get the active workspace.
 */
export function getActiveWorkspace(): string | null {
  return activeWorkspace;
}

/**
 * Check if a file is in the active workspace.
 */
export function isFileInWorkspace(filePath: string): boolean {
  if (!activeWorkspace) return true;
  const absPath = path.resolve(filePath);
  return absPath.startsWith(activeWorkspace);
}

/**
 * Validate that a file is within the active workspace.
 */
export function validateFileWorkspace(filePath: string): string | null {
  if (!isFileInWorkspace(filePath)) {
    return JSON.stringify({
      error: "Context Mismatch",
      message: `The file '${filePath}' is outside the active workspace '${activeWorkspace}'.\n\nCurrent Logic:\n1. I only analyze files from the active project to ensure accuracy and save resources.\n2. You must explicitly switch the workspace if you want to work on a different project.\n\nAction Required:\nPlease call 'switch_workspace(path=\"...\")' with the new project root before retrying.`,
      currentWorkspace: activeWorkspace,
    });
  }
  return null;
}

/**
 * Clear all connections and caches.
 */
export function clearAllConnections(): void {
  for (const conn of activeConnections) {
    try {
      conn.process.kill();
      if (conn.tsserver) conn.tsserver.kill();
    } catch (e) {
      // Ignore
    }
  }
  activeConnections.clear();
  connectionCache.clear();
  documentContents.clear();
  documentVersions.clear();
}

/**
 * Find project root by looking for package.json or tsconfig.json
 */
export function findProjectRoot(filePath: string): string {
  let dir = path.dirname(path.resolve(filePath));
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "tsconfig.json")) ||
      fs.existsSync(path.join(dir, "vite.config.ts")) ||
      fs.existsSync(path.join(dir, "vite.config.js"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(path.resolve(filePath));
}

/**
 * Get file content from cache or disk
 */
export function getFileContent(filePath: string): string {
  const absPath = path.resolve(filePath);
  if (documentContents.has(absPath)) {
    return documentContents.get(absPath)!;
  }
  if (fs.existsSync(absPath)) {
    const content = fs.readFileSync(absPath, "utf-8");
    documentContents.set(absPath, content);
    return content;
  }
  return "";
}

/**
 * Convert offset to line/column (1-based)
 */
export function offsetToPosition(content: string, offset: number): { line: number; column: number } {
  const lines = content.substring(0, offset).split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/**
 * Convert file path to URI
 */
function toUri(filePath: string): string {
  return `file://${path.resolve(filePath)}`;
}

/**
 * Convert URI to file path
 */
function fromUri(uri: string): string {
  return uri.replace("file://", "");
}

/**
 * Send an LSP message to the server
 */
function sendMessage(conn: LspConnection, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    conn.pendingRequests.set(id, { resolve, reject });
    conn.process.stdin?.write(content);

    // Timeout after 60 seconds (large projects need more time)
    setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 60000);
  });
}

/**
 * Send an LSP notification (no response expected)
 */
function sendNotification(conn: LspConnection, method: string, params: any): void {
  const message = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
  });
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  conn.process.stdin?.write(content);
}

/**
 * Parse LSP messages from the buffer
 */
function parseMessages(conn: LspConnection): void {
  while (true) {
    const headerEnd = conn.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = conn.buffer.substring(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length: (\d+)/);
    if (!contentLengthMatch) break;

    const contentLength = parseInt(contentLengthMatch[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;

    if (conn.buffer.length < messageEnd) break;

    const messageStr = conn.buffer.substring(messageStart, messageEnd);
    conn.buffer = conn.buffer.substring(messageEnd);

    try {
      const message = JSON.parse(messageStr);

      // Handle response messages
      if (message.id !== undefined && conn.pendingRequests.has(message.id)) {
        const { resolve, reject } = conn.pendingRequests.get(message.id)!;
        conn.pendingRequests.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      }

      // Handle server requests (has id and method)
      if (message.id !== undefined && message.method) {

        // Handle workspace/configuration request
        if (message.method === "workspace/configuration") {
          const items = message.params?.items || [];
          const response = items.map(() => ({})); // Return empty config for each item
          const responseMsg = JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: response,
          });
          const responseContent = `Content-Length: ${Buffer.byteLength(responseMsg)}\r\n\r\n${responseMsg}`;
          conn.process.stdin?.write(responseContent);
        }
        // Handle client/registerCapability
        else if (message.method === "client/registerCapability") {
          const responseMsg = JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: null,
          });
          const responseContent = `Content-Length: ${Buffer.byteLength(responseMsg)}\r\n\r\n${responseMsg}`;
          conn.process.stdin?.write(responseContent);
        }
        // Handle window/workDoneProgress/create
        else if (message.method === "window/workDoneProgress/create") {
          const responseMsg = JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: null,
          });
          const responseContent = `Content-Length: ${Buffer.byteLength(responseMsg)}\r\n\r\n${responseMsg}`;
          conn.process.stdin?.write(responseContent);
        }
      }

      // Handle notifications (no id, only method)
      if (message.method && message.id === undefined) {
        if (message.method === "textDocument/publishDiagnostics" && message.params) {
          const uri = message.params.uri as string;
          const filePath = fromUri(uri);
          const diagnostics = message.params.diagnostics as LspDiagnostic[];
          conn.diagnosticsCache.set(filePath, diagnostics);
        }

        // Handle tsserver/request notifications (Volar 3.x)
        if (message.method === "tsserver/request" && message.params) {
          const requests = message.params as Array<[number, string, any]>;
          for (const [id, command, args] of requests) {
            // Handle projectInfo locally (needed for tsconfig discovery)
            if (command === "_vue:projectInfo") {
              const projectRoot = conn.projectRoot || process.cwd();
              const tsconfigApp = path.join(projectRoot, "tsconfig.app.json");
              const tsconfig = path.join(projectRoot, "tsconfig.json");
              const configFile = fs.existsSync(tsconfigApp) ? tsconfigApp : tsconfig;
              const result = { configFileName: configFile };

              const responseNotification = JSON.stringify({
                jsonrpc: "2.0",
                method: "tsserver/response",
                params: [[id, result]],
              });
              const responseContent = `Content-Length: ${Buffer.byteLength(responseNotification)}\r\n\r\n${responseNotification}`;
              conn.process.stdin?.write(responseContent);
            }
            // Forward other commands to tsserver
            else {
              forwardToTsServer(conn, id, command, args);
            }
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

/**
 * Create or get LSP connection for a project
 */
async function getConnection(projectRoot: string): Promise<LspConnection> {
  if (connectionCache.has(projectRoot)) {
    return connectionCache.get(projectRoot)!;
  }

  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  let serverPath: string | null = null;
  let args: string[] = [];

  // 1. Try resolving @vue/language-server from the project
  try {
    const pkgPath = projectRequire.resolve("@vue/language-server/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const binPath = pkg.bin ? (typeof pkg.bin === "string" ? pkg.bin : pkg.bin["vue-language-server"]) : "bin/vue-language-server.js";
    serverPath = path.join(path.dirname(pkgPath), binPath);
    args = ["node", serverPath, "--stdio"];
  } catch (e) {
    // 2. Try looking in node_modules manually (fallback)
    const possiblePaths = [
        path.join(projectRoot, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js"),
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            serverPath = p;
            args = ["node", serverPath, "--stdio"];
            break;
        }
    }

    // 3. Fallback to npx if not found
    if (!serverPath) {
        args = ["npx", "@vue/language-server", "--stdio"];
    }
  }

  const proc = spawn(args[0], args.slice(1), {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });

  const conn: LspConnection = {
    process: proc,
    pendingRequests: new Map(),
    initialized: false,
    buffer: "",
    diagnosticsCache: new Map(),
    openedDocuments: new Set(),
    projectRoot,
  };

  activeConnections.add(conn);

  proc.stdout?.on("data", (data: Buffer) => {
    conn.buffer += data.toString();
    parseMessages(conn);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    // Log errors for debugging
    // console.error("[vue-language-server]", data.toString());
  });

  proc.on("error", (error) => {
    console.error("Failed to start vue-language-server:", error);
  });

  proc.on("exit", (code) => {
    connectionCache.delete(projectRoot);
    activeConnections.delete(conn);
  });

  connectionCache.set(projectRoot, conn);

  // Find TypeScript SDK path
  let tsSdkPath: string | undefined;
  try {
    const tsPath = projectRequire.resolve("typescript");
    tsSdkPath = path.dirname(tsPath); // usually lib
  } catch {
      // fallback
      const tsPaths = [
        path.join(projectRoot, "node_modules", "typescript", "lib"),
        path.join(projectRoot, "node_modules", "typescript"),
      ];
      for (const p of tsPaths) {
          if (fs.existsSync(p)) {
              tsSdkPath = p;
              break;
          }
      }
  }

  // Initialize LSP
  await sendMessage(conn, "initialize", {
    processId: process.pid,
    rootUri: toUri(projectRoot),
    rootPath: projectRoot,
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["plaintext", "markdown"] },
        completion: { completionItem: { snippetSupport: true } },
        signatureHelp: {},
        definition: {},
        references: {},
        publishDiagnostics: {},
        synchronization: {
            didOpen: true,
            didChange: true,
            didSave: true,
            dynamicRegistration: true
        }
      },
      workspace: {
        configuration: true,
        workspaceFolders: true,
      },
    },
    initializationOptions: {
      typescript: {
        tsdk: tsSdkPath || "",
      },
      vue: {
        hybridMode: false,
      },
    },
    workspaceFolders: [
      {
        uri: toUri(projectRoot),
        name: path.basename(projectRoot),
      },
    ],
  });

  sendNotification(conn, "initialized", {});
  conn.initialized = true;

  return conn;
}

/**
 * Ensure a document is open in the language server
 */
async function ensureDocumentOpen(conn: LspConnection, filePath: string): Promise<void> {
  const absPath = path.resolve(filePath);
  const uri = toUri(absPath);

  // Skip if already opened in this connection
  if (conn.openedDocuments.has(absPath)) {
    return;
  }

  const content = getFileContent(filePath);
  const version = documentVersions.get(absPath) || 1;

  sendNotification(conn, "textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: filePath.endsWith(".vue") ? "vue" : "typescript",
      version,
      text: content,
    },
  });

  conn.openedDocuments.add(absPath);
}

/**
 * Update document content for incremental analysis
 * Now properly synchronizes with LSP server
 */
export async function updateDocument(filePath: string, content: string): Promise<void> {
  const absPath = path.resolve(filePath);
  const projectRoot = findProjectRoot(filePath);
  
  // Update local cache
  documentContents.set(absPath, content);
  const newVersion = (documentVersions.get(absPath) || 0) + 1;
  documentVersions.set(absPath, newVersion);

  // If we have an active connection, sync with server
  if (connectionCache.has(projectRoot)) {
      const conn = connectionCache.get(projectRoot)!;
      if (conn.openedDocuments.has(absPath)) {
          // Send change notification
          sendNotification(conn, "textDocument/didChange", {
              textDocument: {
                  uri: toUri(absPath),
                  version: newVersion
              },
              contentChanges: [
                  { text: content } // Full text sync for simplicity and robustness
              ]
          });
      }
  }
}

/**
 * Create Vue language service for a project
 */
export async function createVueLanguageService(projectRoot: string): Promise<void> {
  await getConnection(projectRoot);
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
  await ensureDocumentOpen(conn, filePath);

  try {
    const result = await sendMessage(conn, "textDocument/hover", {
      textDocument: { uri: toUri(filePath) },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result || !result.contents) {
      return null;
    }

    let contents = "";
    if (typeof result.contents === "string") {
      contents = result.contents;
    } else if ("value" in result.contents) {
      contents = result.contents.value;
    } else if (Array.isArray(result.contents)) {
      contents = result.contents.map((c: any) => (typeof c === "string" ? c : c.value)).join("\n");
    }

    return { contents };
  } catch (error) {
    console.error("Hover error:", error);
    return null;
  }
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
  await ensureDocumentOpen(conn, filePath);

  try {
    const result = await sendMessage(conn, "textDocument/definition", {
      textDocument: { uri: toUri(filePath) },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result) {
      return [];
    }

    const locations = Array.isArray(result) ? result : [result];
    return locations.map((loc: any) => {
      const uri = loc.targetUri || loc.uri;
      const range = loc.targetRange || loc.range;
      return {
        file: fromUri(uri),
        line: range.start.line + 1,
        column: range.start.character + 1,
      };
    });
  } catch (error) {
    console.error("Definition error:", error);
    return [];
  }
}

/**
 * Get all references to a symbol
 */
export async function getReferences(
  filePath: string,
  line: number,
  column: number
): Promise<Array<{ file: string; line: number; column: number }>> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  await ensureDocumentOpen(conn, filePath);

  try {
    const result = await sendMessage(conn, "textDocument/references", {
      textDocument: { uri: toUri(filePath) },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    });

    if (!result) {
      return [];
    }

    return result.map((loc: any) => ({
      file: fromUri(loc.uri),
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
    }));
  } catch (error) {
    console.error("References error:", error);
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
  await ensureDocumentOpen(conn, filePath);

  try {
    const result = await sendMessage(conn, "textDocument/completion", {
      textDocument: { uri: toUri(filePath) },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result) {
      return { items: [], isIncomplete: false };
    }

    const items = (result.items || result).slice(0, limit).map((item: any) => ({
      name: item.label,
      kind: getCompletionKindName(item.kind),
    }));

    return {
      items,
      isIncomplete: result.isIncomplete || false,
    };
  } catch (error) {
    console.error("Completion error:", error);
    return { items: [], isIncomplete: false };
  }
}

/**
 * Get completion kind name from kind number
 */
function getCompletionKindName(kind: number): string {
  const kinds: Record<number, string> = {
    1: "text",
    2: "method",
    3: "function",
    4: "constructor",
    5: "field",
    6: "variable",
    7: "class",
    8: "interface",
    9: "module",
    10: "property",
    11: "unit",
    12: "value",
    13: "enum",
    14: "keyword",
    15: "snippet",
    16: "color",
    17: "file",
    18: "reference",
    19: "folder",
    20: "enumMember",
    21: "constant",
    22: "struct",
    23: "event",
    24: "operator",
    25: "typeParameter",
  };
  return kinds[kind] || "unknown";
}

/**
 * Get signature help at a position
 */
export async function getSignatureHelp(
  filePath: string,
  line: number,
  column: number
): Promise<{
  signatures: Array<{ label: string; documentation?: string }>;
  activeSignature: number;
  activeParameter: number;
} | null> {
  const projectRoot = findProjectRoot(filePath);
  const conn = await getConnection(projectRoot);
  await ensureDocumentOpen(conn, filePath);

  try {
    const result = await sendMessage(conn, "textDocument/signatureHelp", {
      textDocument: { uri: toUri(filePath) },
      position: { line: line - 1, character: column - 1 },
    });

    if (!result || !result.signatures) {
      return null;
    }

    return {
      signatures: result.signatures.map((sig: any) => ({
        label: sig.label,
        documentation: typeof sig.documentation === "string" ? sig.documentation : undefined,
      })),
      activeSignature: result.activeSignature || 0,
      activeParameter: result.activeParameter || 0,
    };
  } catch (error) {
    console.error("Signature help error:", error);
    return null;
  }
}

/**
 * Diagnostic type for internal use
 */
interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  code?: string | number;
  source?: string;
}

/**
 * Get diagnostics for a file
 * 
 * Strategy:
 * 1. For single files, prefer LSP diagnostics (faster, incremental)
 * 2. Fallback to vue-tsc only if LSP unavailable or for project-wide checks (if needed)
 */
export async function getDiagnostics(filePath: string): Promise<Diagnostic[]> {
  const projectRoot = findProjectRoot(filePath);
  const absPath = path.resolve(filePath);
  
  // Try to use LSP first for single file
  try {
      const conn = await getConnection(projectRoot);
      await ensureDocumentOpen(conn, absPath);
      
      // Wait briefly for diagnostics to arrive (push model)
      // If we already have them in cache, return immediately
      // Otherwise wait up to 2 seconds
      let attempts = 0;
      while (attempts < 10) {
          if (conn.diagnosticsCache.has(absPath)) {
              return conn.diagnosticsCache.get(absPath)!;
          }
          await new Promise(r => setTimeout(r, 200));
          attempts++;
      }
      
      // If we still have no diagnostics, it might mean there are no errors,
      // or the server is slow. Return empty or cached if available.
      return conn.diagnosticsCache.get(absPath) || [];
      
  } catch (e) {
      // If LSP fails, fallback to vue-tsc logic (legacy)
      console.error("LSP diagnostics failed, falling back to vue-tsc spawn:", e);
  }

  // Old heavy logic (fallback)
  const vueTscPaths = [
    path.join(projectRoot, "node_modules", ".bin", "vue-tsc"),
    path.join(projectRoot, "node_modules", "vue-tsc", "bin", "vue-tsc.js"),
  ];

  let vueTscPath: string | null = null;
  for (const p of vueTscPaths) {
    if (fs.existsSync(p)) {
      vueTscPath = p;
      break;
    }
  }

  if (!vueTscPath) {
    vueTscPath = "npx";
  }

  return new Promise((resolve) => {
    // Pass the specific file to vue-tsc for faster checking
    const args = vueTscPath === "npx"
      ? ["vue-tsc", "--noEmit", "--pretty", "false", absPath]
      : ["--noEmit", "--pretty", "false", absPath];

    const proc = spawn(vueTscPath!, args, {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", () => {
      resolve([]);
    });

    proc.on("close", () => {
      const output = stdout + stderr;
      const diagnostics: Diagnostic[] = [];

      // Parse TypeScript/vue-tsc output format: file(line,col): error TS1234: message
      const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/gm;
      let match;

      while ((match = regex.exec(output)) !== null) {
        const file = match[1];
        const line = parseInt(match[2], 10);
        const col = parseInt(match[3], 10);
        const severity = match[4] === "error" ? 1 : 2;
        const code = parseInt(match[5], 10);
        const message = match[6];

        // Resolve relative paths from projectRoot
        const resolvedFile = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);

        // Only include diagnostics for the requested file
        if (resolvedFile === absPath) {
          diagnostics.push({
            range: {
              start: { line: line - 1, character: col - 1 },
              end: { line: line - 1, character: col },
            },
            severity,
            message,
            code,
            source: "vue-tsc",
          });
        }
      }

      resolve(diagnostics);
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.kill();
      resolve([]);
    }, 30000);
  });
}

/**
 * Format a diagnostic for output
 */
export function formatDiagnostic(diag: Diagnostic): {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  code?: string | number;
} {
  const severityMap: Record<number, string> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
  };

  return {
    file: "",
    line: diag.range.start.line + 1,
    column: diag.range.start.character + 1,
    severity: severityMap[diag.severity || 1] || "error",
    message: diag.message,
    code: diag.code,
  };
}

/**
 * Get project status
 */
export async function getProjectStatus(filePath: string): Promise<{
  projectRoot: string;
  hasVue: boolean;
  vueVersion?: string;
  hasVolar: boolean;
  hasTsConfig: boolean;
  tips: string[];
}> {
  const projectRoot = findProjectRoot(filePath);
  const nodeModulesPath = path.join(projectRoot, "node_modules");

  // Check for Vue
  const vuePath = path.join(nodeModulesPath, "vue");
  const hasVue = fs.existsSync(vuePath);
  let vueVersion: string | undefined;
  if (hasVue) {
    try {
      const vuePkg = JSON.parse(fs.readFileSync(path.join(vuePath, "package.json"), "utf-8"));
      vueVersion = vuePkg.version;
    } catch {
      // Ignore
    }
  }

  // Check for Volar/vue-tsc
  const hasVolar =
    fs.existsSync(path.join(nodeModulesPath, "vue-tsc")) ||
    fs.existsSync(path.join(nodeModulesPath, "@vue", "language-server"));

  // Check for tsconfig
  const hasTsConfig = fs.existsSync(path.join(projectRoot, "tsconfig.json"));

  // Build tips
  const tips: string[] = [];
  if (!hasVue) {
    tips.push("Vue is not installed. Run: npm install vue");
  }
  if (!hasTsConfig) {
    tips.push("No tsconfig.json found. Consider adding one for better type checking.");
  }
  if (hasVue && !hasVolar) {
    tips.push("Consider installing vue-tsc for full Vue type checking: npm install -D vue-tsc");
  }
  if (hasVue && !fs.existsSync(path.join(nodeModulesPath, "@vue", "language-server"))) {
    tips.push("Install @vue/language-server for this MCP to work: npm install -D @vue/language-server");
  }

  return {
    projectRoot,
    hasVue,
    vueVersion,
    hasVolar,
    hasTsConfig,
    tips,
  };
}