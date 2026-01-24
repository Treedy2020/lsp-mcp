#!/usr/bin/env node

/**
 * Direct test of pyright-langserver LSP connection
 */

import { spawn } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testFile = path.join(__dirname, 'test.py');
const workspaceRoot = path.dirname(__dirname);

console.log('=== Testing LSP Connection ===');
console.log('Workspace:', workspaceRoot);
console.log('Test file:', testFile);

// Spawn pyright-langserver
console.log('\n1. Spawning pyright-langserver...');
const pyrightProcess = spawn('pyright-langserver', ['--stdio'], {
  stdio: ['pipe', 'pipe', 'ignore'],
  cwd: workspaceRoot,
});

pyrightProcess.on('error', (err) => {
  console.error('Process error:', err);
  process.exit(1);
});

pyrightProcess.on('exit', (code, signal) => {
  console.log(`Process exited: code=${code}, signal=${signal}`);
});

// Create JSON-RPC connection
console.log('2. Creating JSON-RPC connection...');
const connection = createMessageConnection(
  new StreamMessageReader(pyrightProcess.stdout),
  new StreamMessageWriter(pyrightProcess.stdin)
);

connection.listen();

async function test() {
  try {
    // Initialize
    console.log('\n3. Sending initialize request...');
    const initResult = await connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri: `file://${workspaceRoot}`,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
      },
      workspaceFolders: [
        {
          uri: `file://${workspaceRoot}`,
          name: 'test',
        },
      ],
    });
    console.log('Initialize result:', JSON.stringify(initResult.capabilities?.hoverProvider));

    // Initialized notification
    console.log('\n4. Sending initialized notification...');
    await connection.sendNotification('initialized', {});
    console.log('Initialized notification sent');

    // Open document
    console.log('\n5. Opening document...');
    const content = fs.readFileSync(testFile, 'utf-8');
    const uri = `file://${testFile}`;

    await connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'python',
        version: 1,
        text: content,
      },
    });
    console.log('Document opened');

    // Wait for analysis
    console.log('\n6. Waiting for analysis (500ms)...');
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('Wait complete');

    // Hover request
    console.log('\n7. Sending hover request...');
    const hoverResult = await connection.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: 5, character: 4 },
    });
    console.log('Hover result:', JSON.stringify(hoverResult, null, 2));

    // Document symbols request
    console.log('\n8. Sending documentSymbol request...');
    const symbolsResult = await connection.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    console.log('Symbols found:', symbolsResult?.length || 0);
    if (symbolsResult?.length > 0) {
      symbolsResult.forEach(s => console.log(`  - ${s.name} (${s.kind})`));
    }

    console.log('\n=== All tests passed! ===');

    // Shutdown
    console.log('\n9. Shutting down...');
    await connection.sendRequest('shutdown');
    await connection.sendNotification('exit');
    connection.dispose();
    pyrightProcess.kill();

    console.log('Done!');
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    pyrightProcess.kill();
    process.exit(1);
  }
}

// Run with timeout
const timeout = setTimeout(() => {
  console.error('Test timed out after 30 seconds');
  pyrightProcess.kill();
  process.exit(1);
}, 30000);

test().finally(() => clearTimeout(timeout));
