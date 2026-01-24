// Test script to verify the MCP server works correctly
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const fixturesDir = resolve(__dirname, '../../fixtures');

async function main() {
  console.log('=== Starting MCP client test ===\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(projectRoot, 'dist/index.js'), fixturesDir],
  });

  const client = new Client({
    name: 'test-client',
    version: '1.0.0',
  });

  await client.connect(transport);
  console.log('Connected to MCP server\n');

  // List tools
  console.log('=== Listing tools ===');
  const tools = await client.listTools();
  for (const tool of tools.tools) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }

  const testFile = resolve(fixturesDir, 'test.py');
  const crossFileTest = resolve(fixturesDir, 'test_cross_file.py');
  const modelsFile = resolve(fixturesDir, 'mypackage/models.py');
  const servicesFile = resolve(fixturesDir, 'mypackage/services.py');

  // Test hover
  console.log('\n=== Testing hover tool ===');
  const hoverResult = await client.callTool({
    name: 'hover',
    arguments: {
      file: testFile,
      line: 6,
      column: 5,
    },
  });
  console.log('Hover result:');
  console.log(hoverResult.content[0].text);

  // Test definition
  console.log('\n=== Testing definition tool ===');
  const defResult = await client.callTool({
    name: 'definition',
    arguments: {
      file: testFile,
      line: 54,
      column: 15,
    },
  });
  console.log('Definition result:');
  console.log(defResult.content[0].text);

  // Test diagnostics
  console.log('\n=== Testing diagnostics tool ===');
  const diagResult = await client.callTool({
    name: 'diagnostics',
    arguments: {
      path: testFile,
    },
  });
  console.log('Diagnostics result:');
  console.log(diagResult.content[0].text);

  // Test completions
  console.log('\n=== Testing completions tool ===');
  const compResult = await client.callTool({
    name: 'completions',
    arguments: {
      file: testFile,
      line: 56,
      column: 10,
    },
  });
  console.log('Completions result:');
  console.log(compResult.content[0].text);

  // Test symbols
  console.log('\n=== Testing symbols tool ===');
  const symbolsResult = await client.callTool({
    name: 'symbols',
    arguments: {
      file: testFile,
    },
  });
  console.log('Symbols result:');
  console.log(symbolsResult.content[0].text);

  // ========== Cross-file tests ==========
  console.log('\n========== Cross-file tests ==========');

  // Test cross-file hover (hover over imported symbol)
  console.log('\n=== Testing cross-file hover (UserService) ===');
  const crossHoverResult = await client.callTool({
    name: 'hover',
    arguments: {
      file: crossFileTest,
      line: 17,  // user_service = UserService()
      column: 20,
    },
  });
  console.log('Cross-file hover result:');
  console.log(crossHoverResult.content[0].text);

  // Test cross-file definition (go to definition of imported class)
  console.log('\n=== Testing cross-file definition (User) ===');
  const crossDefResult = await client.callTool({
    name: 'definition',
    arguments: {
      file: crossFileTest,
      line: 11,  // from mypackage import User
      column: 24,
    },
  });
  console.log('Cross-file definition result:');
  console.log(crossDefResult.content[0].text);

  // Test cross-file references (find all references to format_price)
  console.log('\n=== Testing cross-file references (format_price) ===');
  const crossRefResult = await client.callTool({
    name: 'references',
    arguments: {
      file: crossFileTest,
      line: 42,  // price_str = format_price(...)
      column: 20,  // middle of "format_price"
    },
  });
  console.log('Cross-file references result:');
  console.log(crossRefResult.content[0].text);

  // Test symbols in services.py
  console.log('\n=== Testing symbols in services.py ===');
  const servicesSymbolsResult = await client.callTool({
    name: 'symbols',
    arguments: {
      file: servicesFile,
      filter: 'classes',
    },
  });
  console.log('Services symbols result:');
  console.log(servicesSymbolsResult.content[0].text);

  // Test hover on method from another file
  console.log('\n=== Testing hover on apply_discount (from models.py) ===');
  const methodHoverResult = await client.callTool({
    name: 'hover',
    arguments: {
      file: crossFileTest,
      line: 50,  // discounted = laptop.apply_discount(10)
      column: 26,
    },
  });
  console.log('Method hover result:');
  console.log(methodHoverResult.content[0].text);

  console.log('\n=== All tests passed ===');
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
