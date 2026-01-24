import * as fs from 'fs';
import {
  Position,
  Hover,
  Location,
  LocationLink,
  CompletionItem,
  CompletionList,
  SignatureHelp,
  WorkspaceEdit,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  SymbolInformation,
} from 'vscode-languageserver-protocol';
import { findProjectRoot } from './utils/position.js';
import { getConnectionManager, LspConnectionManager } from './lsp/index.js';

function log(message: string): void {
  console.error(`[LSP] ${message}`);
}

export class LspClient {
  private connectionManager: LspConnectionManager;

  constructor() {
    this.connectionManager = getConnectionManager();
  }

  async start(): Promise<void> {
    // Connection is created lazily on first request
  }

  async stop(): Promise<void> {
    await this.connectionManager.closeAll();
  }

  /**
   * Ensure a document is open in the LSP server
   */
  private async ensureDocumentOpen(
    workspaceRoot: string,
    filePath: string
  ): Promise<void> {
    const docManager = this.connectionManager.getDocumentManager(workspaceRoot);

    if (docManager.isDocumentOpen(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    await this.connectionManager.openDocument(workspaceRoot, filePath, content);
  }

  /**
   * Get or create a connection and ensure document is open
   */
  private async prepareRequest(filePath: string): Promise<string> {
    const workspaceRoot = findProjectRoot(filePath);
    log(`Workspace root: ${workspaceRoot}`);

    // Get or create connection
    await this.connectionManager.getConnection({ workspaceRoot });

    // Ensure document is open
    await this.ensureDocumentOpen(workspaceRoot, filePath);

    return workspaceRoot;
  }

  /**
   * Get the document URI for a file path
   */
  private getDocumentUri(workspaceRoot: string, filePath: string): string {
    return this.connectionManager.getDocumentManager(workspaceRoot).filePathToUri(filePath);
  }

  async hover(filePath: string, position: Position): Promise<Hover | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending hover request');
    return await this.connectionManager.sendRequest<Hover | null>(
      workspaceRoot,
      'textDocument/hover',
      {
        textDocument: { uri },
        position,
      }
    );
  }

  async definition(
    filePath: string,
    position: Position
  ): Promise<Location | Location[] | LocationLink[] | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending definition request');
    return await this.connectionManager.sendRequest<Location | Location[] | LocationLink[] | null>(
      workspaceRoot,
      'textDocument/definition',
      {
        textDocument: { uri },
        position,
      }
    );
  }

  async references(
    filePath: string,
    position: Position,
    includeDeclaration = true
  ): Promise<Location[] | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending references request');
    return await this.connectionManager.sendRequest<Location[] | null>(
      workspaceRoot,
      'textDocument/references',
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      }
    );
  }

  async completions(
    filePath: string,
    position: Position
  ): Promise<CompletionItem[] | CompletionList | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending completions request');
    return await this.connectionManager.sendRequest<CompletionItem[] | CompletionList | null>(
      workspaceRoot,
      'textDocument/completion',
      {
        textDocument: { uri },
        position,
      }
    );
  }

  async signatureHelp(filePath: string, position: Position): Promise<SignatureHelp | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending signatureHelp request');
    return await this.connectionManager.sendRequest<SignatureHelp | null>(
      workspaceRoot,
      'textDocument/signatureHelp',
      {
        textDocument: { uri },
        position,
      }
    );
  }

  async rename(
    filePath: string,
    position: Position,
    newName: string
  ): Promise<WorkspaceEdit | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending rename request');
    return await this.connectionManager.sendRequest<WorkspaceEdit | null>(
      workspaceRoot,
      'textDocument/rename',
      {
        textDocument: { uri },
        position,
        newName,
      }
    );
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    // For diagnostics, we need to use the publishDiagnostics notification
    // But pyright-langserver doesn't support workspace/diagnostic
    // So we'll need to trigger analysis and wait for the notification

    // For now, we'll use a workaround: re-open the document to trigger analysis
    const content = fs.readFileSync(filePath, 'utf-8');
    const docManager = this.connectionManager.getDocumentManager(workspaceRoot);

    // Close and reopen to get fresh diagnostics
    if (docManager.isDocumentOpen(filePath)) {
      await this.connectionManager.closeDocument(workspaceRoot, filePath);
    }
    await this.connectionManager.openDocument(workspaceRoot, filePath, content);

    // Wait a bit for diagnostics
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Since pyright doesn't directly return diagnostics via request,
    // we need a different approach. Let's use the CLI for diagnostics.
    log('Getting diagnostics via CLI');
    return this.getDiagnosticsViaCli(filePath, workspaceRoot);
  }

  /**
   * Get diagnostics using pyright CLI (more reliable for batch analysis)
   */
  private getDiagnosticsViaCli(filePath: string, workspaceRoot: string): Diagnostic[] {
    const { execSync } = require('child_process');

    try {
      const result = execSync(`pyright --outputjson "${filePath}"`, {
        encoding: 'utf-8',
        cwd: workspaceRoot,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parsed = JSON.parse(result);
      return this.convertPyrightDiagnostics(parsed);
    } catch (error: unknown) {
      // pyright exits with non-zero if there are errors, but still outputs JSON
      if (error && typeof error === 'object' && 'stdout' in error) {
        try {
          const parsed = JSON.parse((error as { stdout: string }).stdout);
          return this.convertPyrightDiagnostics(parsed);
        } catch {
          // Fall through to return empty
        }
      }
      return [];
    }
  }

  /**
   * Convert pyright CLI output to LSP diagnostics
   */
  private convertPyrightDiagnostics(output: {
    generalDiagnostics?: Array<{
      file: string;
      severity: number;
      message: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      rule?: string;
    }>;
  }): Diagnostic[] {
    if (!output.generalDiagnostics) {
      return [];
    }

    return output.generalDiagnostics.map((d) => ({
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      severity: d.severity as DiagnosticSeverity,
      message: d.message,
      source: 'pyright',
      code: d.rule,
    }));
  }

  /**
   * Get document symbols (classes, functions, methods, etc.)
   */
  async documentSymbols(
    filePath: string
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const workspaceRoot = await this.prepareRequest(filePath);
    const uri = this.getDocumentUri(workspaceRoot, filePath);

    log('Sending documentSymbol request');
    return await this.connectionManager.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
      workspaceRoot,
      'textDocument/documentSymbol',
      {
        textDocument: { uri },
      }
    );
  }

  /**
   * Update a document's content (for incremental updates)
   */
  async updateDocument(filePath: string, content: string): Promise<void> {
    const workspaceRoot = findProjectRoot(filePath);

    // Ensure connection exists
    await this.connectionManager.getConnection({ workspaceRoot });

    // Update document
    await this.connectionManager.updateDocument(workspaceRoot, filePath, content);

    log(`Updated document: ${filePath}`);
  }

  /**
   * Get connection status for debugging
   */
  getStatus(): { workspaceRoot: string; initialized: boolean; lastUsed: Date }[] {
    return this.connectionManager.getStatus();
  }
}

let client: LspClient | null = null;

export function getLspClient(): LspClient {
  if (!client) {
    client = new LspClient();
  }
  return client;
}

/**
 * Gracefully shutdown the LSP client
 */
export async function shutdownLspClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = null;
  }
}
