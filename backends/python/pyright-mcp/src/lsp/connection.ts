import { spawn } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';
import type { MessageConnection } from 'vscode-jsonrpc/node.js';
import type { LspConnection, ConnectionOptions } from './types.js';
import { DocumentManager } from './document-manager.js';

/**
 * Manages persistent LSP connections to pyright-langserver.
 * Maintains one connection per workspace root.
 */
export class LspConnectionManager {
  private connections: Map<string, LspConnection> = new Map();
  private documentManagers: Map<string, DocumentManager> = new Map();
  private initializationPromises: Map<string, Promise<LspConnection>> = new Map();

  /** Default timeout for initialization */
  private static readonly DEFAULT_INIT_TIMEOUT = 10000;

  /** Time to wait after opening a document before it's ready for analysis */
  private static readonly DOCUMENT_READY_DELAY = 500;

  /**
   * Get or create a connection for the given workspace
   */
  async getConnection(options: ConnectionOptions): Promise<LspConnection> {
    const { workspaceRoot } = options;

    // Check for existing initialized connection
    const existing = this.connections.get(workspaceRoot);
    if (existing && existing.initialized) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // Check if initialization is already in progress
    const pendingInit = this.initializationPromises.get(workspaceRoot);
    if (pendingInit) {
      return pendingInit;
    }

    // Create new connection
    const initPromise = this.createConnection(options);
    this.initializationPromises.set(workspaceRoot, initPromise);

    try {
      const connection = await initPromise;
      this.connections.set(workspaceRoot, connection);
      return connection;
    } finally {
      this.initializationPromises.delete(workspaceRoot);
    }
  }

  /**
   * Get the document manager for a workspace
   */
  getDocumentManager(workspaceRoot: string): DocumentManager {
    let manager = this.documentManagers.get(workspaceRoot);
    if (!manager) {
      manager = new DocumentManager();
      this.documentManagers.set(workspaceRoot, manager);
    }
    return manager;
  }

  /**
   * Create and initialize a new LSP connection
   */
  private async createConnection(options: ConnectionOptions): Promise<LspConnection> {
    const { workspaceRoot, initTimeout = LspConnectionManager.DEFAULT_INIT_TIMEOUT } = options;

    // Spawn pyright-langserver
    // Use 'ignore' for stderr to prevent buffer blocking since MCP uses stdio
    const pyrightProcess = spawn('pyright-langserver', ['--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: workspaceRoot,
    });

    // Handle process errors
    pyrightProcess.on('error', (err) => {
      console.error(`[LSP] Process error for ${workspaceRoot}:`, err);
      this.closeConnection(workspaceRoot);
    });

    pyrightProcess.on('exit', (code, signal) => {
      console.error(`[LSP] Process exited for ${workspaceRoot}: code=${code}, signal=${signal}`);
      this.connections.delete(workspaceRoot);
    });

    console.error(`[LSP] Spawned pyright-langserver for ${workspaceRoot}`);

    // Create JSON-RPC connection
    const connection: MessageConnection = createMessageConnection(
      new StreamMessageReader(pyrightProcess.stdout!),
      new StreamMessageWriter(pyrightProcess.stdin!)
    );

    // Handle connection errors
    connection.onError((error) => {
      console.error(`[LSP] Connection error for ${workspaceRoot}:`, error);
    });

    connection.onClose(() => {
      console.error(`[LSP] Connection closed for ${workspaceRoot}`);
    });

    connection.listen();

    const connectionId = Math.random().toString(36).slice(2, 8);
    console.error(`[LSP] Created connection ${connectionId}`);

    const lspConnection: LspConnection = {
      connection,
      process: pyrightProcess,
      workspaceRoot,
      initialized: false,
      lastUsed: Date.now(),
      id: connectionId,
    } as LspConnection & { id: string };

    // Initialize the connection with timeout
    await this.initializeConnection(lspConnection, initTimeout);

    return lspConnection;
  }

  /**
   * Initialize an LSP connection
   */
  private async initializeConnection(
    lspConnection: LspConnection,
    timeout: number
  ): Promise<void> {
    const { connection, workspaceRoot } = lspConnection;

    const initPromise = (async () => {
      // Send initialize request
      console.error(`[LSP] Sending initialize request...`);
      const initResult = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: `file://${workspaceRoot}`,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['markdown', 'plaintext'] },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            publishDiagnostics: {},
          },
          // Note: Do NOT declare workspace.workspaceFolders capability
          // pyright-langserver will send workspace/workspaceFolders requests
          // that we don't handle, causing requests to hang
        },
        workspaceFolders: [
          {
            uri: `file://${workspaceRoot}`,
            name: workspaceRoot.split('/').pop() || 'workspace',
          },
        ],
      });

      // Send initialized notification
      console.error(`[LSP] Sending initialized notification...`);
      await connection.sendNotification('initialized', {});

      console.error(`[LSP] Connection initialized successfully`);
      lspConnection.initialized = true;
    })();

    // Race against timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`LSP initialization timed out after ${timeout}ms`)), timeout);
    });

    await Promise.race([initPromise, timeoutPromise]);
  }

  /**
   * Open a document in the LSP server
   */
  async openDocument(workspaceRoot: string, filePath: string, content: string): Promise<void> {
    const lspConnection = this.connections.get(workspaceRoot);
    if (!lspConnection || !lspConnection.initialized) {
      throw new Error(`No initialized connection for workspace: ${workspaceRoot}`);
    }

    const docManager = this.getDocumentManager(workspaceRoot);

    // Skip if already open
    if (docManager.isDocumentOpen(filePath)) {
      return;
    }

    // Register with document manager
    const docState = docManager.openDocument(filePath, content);

    // Send didOpen notification
    console.error(`[LSP] Sending didOpen for ${filePath}...`);
    await lspConnection.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: docState.uri,
        languageId: docState.languageId,
        version: docState.version,
        text: docState.content,
      },
    });

    // Wait for analysis
    console.error(`[LSP] Waiting for analysis...`);
    await this.waitForAnalysis();
    console.error(`[LSP] Document ready: ${filePath}`);
  }

  /**
   * Update a document's content
   */
  async updateDocument(workspaceRoot: string, filePath: string, newContent: string): Promise<void> {
    const lspConnection = this.connections.get(workspaceRoot);
    if (!lspConnection || !lspConnection.initialized) {
      throw new Error(`No initialized connection for workspace: ${workspaceRoot}`);
    }

    const docManager = this.getDocumentManager(workspaceRoot);

    // If not open, open it instead
    if (!docManager.isDocumentOpen(filePath)) {
      await this.openDocument(workspaceRoot, filePath, newContent);
      return;
    }

    // Update document manager
    const newVersion = docManager.updateDocument(filePath, newContent);
    const uri = docManager.filePathToUri(filePath);

    // Send didChange notification (full sync)
    await lspConnection.connection.sendNotification('textDocument/didChange', {
      textDocument: {
        uri,
        version: newVersion,
      },
      contentChanges: [{ text: newContent }],
    });

    // Wait for analysis
    await this.waitForAnalysis();
  }

  /**
   * Close a document in the LSP server
   */
  async closeDocument(workspaceRoot: string, filePath: string): Promise<void> {
    const lspConnection = this.connections.get(workspaceRoot);
    if (!lspConnection || !lspConnection.initialized) {
      return;
    }

    const docManager = this.getDocumentManager(workspaceRoot);
    if (!docManager.isDocumentOpen(filePath)) {
      return;
    }

    const uri = docManager.filePathToUri(filePath);

    // Send didClose notification
    await lspConnection.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });

    // Remove from document manager
    docManager.closeDocument(filePath);
  }

  /**
   * Wait for LSP analysis to complete
   */
  private async waitForAnalysis(): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, LspConnectionManager.DOCUMENT_READY_DELAY)
    );
  }

  /**
   * Send an LSP request
   */
  async sendRequest<T>(workspaceRoot: string, method: string, params: unknown): Promise<T> {
    const lspConnection = this.connections.get(workspaceRoot);
    if (!lspConnection || !lspConnection.initialized) {
      throw new Error(`No initialized connection for workspace: ${workspaceRoot}`);
    }

    lspConnection.lastUsed = Date.now();
    console.error(`[LSP] sendRequest: ${method}`);

    // 直接发送请求，不使用 Promise.race
    const result = await lspConnection.connection.sendRequest(method, params);
    console.error(`[LSP] Request ${method} done`);
    return result as T;
  }

  /**
   * Close a specific connection
   */
  async closeConnection(workspaceRoot: string): Promise<void> {
    const lspConnection = this.connections.get(workspaceRoot);
    if (!lspConnection) {
      return;
    }

    // Close all documents
    const docManager = this.documentManagers.get(workspaceRoot);
    if (docManager) {
      docManager.closeAll();
      this.documentManagers.delete(workspaceRoot);
    }

    // Send shutdown request if initialized
    if (lspConnection.initialized) {
      try {
        await lspConnection.connection.sendRequest('shutdown');
        await lspConnection.connection.sendNotification('exit');
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Dispose connection
    lspConnection.connection.dispose();

    // Kill process
    if (!lspConnection.process.killed) {
      lspConnection.process.kill();
    }

    this.connections.delete(workspaceRoot);
  }

  /**
   * Close all connections (for graceful shutdown)
   */
  async closeAll(): Promise<void> {
    const workspaceRoots = Array.from(this.connections.keys());
    await Promise.all(workspaceRoots.map((root) => this.closeConnection(root)));
  }

  /**
   * Get connection status for debugging
   */
  getStatus(): { workspaceRoot: string; initialized: boolean; lastUsed: Date }[] {
    return Array.from(this.connections.entries()).map(([root, conn]) => ({
      workspaceRoot: root,
      initialized: conn.initialized,
      lastUsed: new Date(conn.lastUsed),
    }));
  }
}

// Singleton instance
let connectionManagerInstance: LspConnectionManager | null = null;

/**
 * Get the global connection manager instance
 */
export function getConnectionManager(): LspConnectionManager {
  if (!connectionManagerInstance) {
    connectionManagerInstance = new LspConnectionManager();
  }
  return connectionManagerInstance;
}
