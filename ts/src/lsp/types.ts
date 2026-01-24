import type { MessageConnection } from 'vscode-jsonrpc/node.js';
import type { ChildProcess } from 'child_process';

/**
 * Represents an active LSP connection to a pyright-langserver process
 */
export interface LspConnection {
  /** The JSON-RPC message connection */
  connection: MessageConnection;
  /** The underlying child process */
  process: ChildProcess;
  /** The workspace root this connection is for */
  workspaceRoot: string;
  /** Whether the connection is initialized */
  initialized: boolean;
  /** When this connection was last used */
  lastUsed: number;
}

/**
 * Document state tracked by the document manager
 */
export interface DocumentState {
  /** Document URI */
  uri: string;
  /** Current version number */
  version: number;
  /** Last known content */
  content: string;
  /** Language ID (always 'python' for us) */
  languageId: string;
}

/**
 * Options for getting/creating a connection
 */
export interface ConnectionOptions {
  /** Workspace root path */
  workspaceRoot: string;
  /** Timeout for initialization in ms */
  initTimeout?: number;
}

/**
 * Result of an LSP request
 */
export interface LspResult<T> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Symbol filter options for the symbols tool
 */
export type SymbolFilter = 'all' | 'classes' | 'functions' | 'methods' | 'variables';

/**
 * Symbol kind names mapping from LSP SymbolKind enum
 */
export const SymbolKindNames: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};
