#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { hover, hoverSchema } from './tools/hover.js';
import { definition, definitionSchema } from './tools/definition.js';
import { references, referencesSchema } from './tools/references.js';
import { completions, completionsSchema } from './tools/completions.js';
import { diagnostics, diagnosticsSchema } from './tools/diagnostics.js';
import { signatureHelp, signatureHelpSchema } from './tools/signature-help.js';
import { rename, renameSchema } from './tools/rename.js';
import { search, searchSchema } from './tools/search.js';
import { status, statusSchema } from './tools/status.js';
import { symbols, symbolsSchema } from './tools/symbols.js';
import { updateDocument, updateDocumentSchema } from './tools/update-document.js';
import { getLspClient, shutdownLspClient } from './lsp-client.js';

const server = new McpServer({
  name: 'pyright-mcp',
  version: '1.0.0',
});

// Register hover tool
server.tool(
  'hover',
  'Get type information and documentation at a specific position in a Python file',
  hoverSchema,
  async (args) => hover(args)
);

// Register definition tool
server.tool(
  'definition',
  'Go to definition of a symbol at a specific position in a Python file',
  definitionSchema,
  async (args) => definition(args)
);

// Register references tool
server.tool(
  'references',
  'Find all references to a symbol at a specific position in a Python file',
  referencesSchema,
  async (args) => references(args)
);

// Register completions tool
server.tool(
  'completions',
  'Get code completion suggestions at a specific position in a Python file',
  completionsSchema,
  async (args) => completions(args)
);

// Register diagnostics tool
server.tool(
  'diagnostics',
  'Get diagnostics (errors, warnings) for a Python file',
  diagnosticsSchema,
  async (args) => diagnostics(args)
);

// Register signature help tool
server.tool(
  'signature_help',
  'Get function signature help at a specific position in a Python file',
  signatureHelpSchema,
  async (args) => signatureHelp(args)
);

// Register rename tool
server.tool(
  'rename',
  'Preview renaming a symbol at a specific position in a Python file',
  renameSchema,
  async (args) => rename(args)
);

// Register search tool
server.tool(
  'search',
  'Search for a pattern in files and return file:line:column locations',
  searchSchema,
  async (args) => search(args)
);

// Register status tool
server.tool(
  'status',
  'Check Python/Pyright environment status for a project',
  statusSchema,
  async (args) => status(args)
);

// Register symbols tool
server.tool(
  'symbols',
  'Extract symbols (classes, functions, methods, variables) from a Python file',
  symbolsSchema,
  async (args) => symbols(args)
);

// Register update_document tool
server.tool(
  'update_document',
  'Update the content of an open Python file for incremental analysis',
  updateDocumentSchema,
  async (args) => updateDocument(args)
);

/**
 * Gracefully shutdown the server
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.error(`\n[Server] Received ${signal}, shutting down gracefully...`);

  try {
    // Close all LSP connections
    await shutdownLspClient();
    console.error('[Server] LSP connections closed');

    // Close the MCP server
    await server.close();
    console.error('[Server] MCP server closed');

    process.exit(0);
  } catch (error) {
    console.error('[Server] Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
async function main() {
  console.error(`Pyright MCP server`);
  console.error(`  Workspace: auto-detected from file path`);

  // Initialize LSP client (lazy start on first request)
  getLspClient();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`  Ready`);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
