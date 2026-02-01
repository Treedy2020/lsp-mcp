import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "pipe",
});

const client = new Client(
  { name: "mcp-smoke-python", version: "0.0.1" },
  { capabilities: {} }
);

const FIXTURE_PATH = path.resolve(process.cwd(), "..", "test-fixtures", "test_sample.py");

try {
  console.log("Connecting...");
  await client.connect(transport);
  
  console.log("Calling python_status...");
  const status = await client.callTool({ name: "python_status", arguments: {} });
  console.log("python_status OK");

  console.log(`Calling python_hover on ${FIXTURE_PATH}...`);
  // Hover over "greet" in `def greet(name: str)` which is on line 3 (0-indexed might be line 2)
  // Let's assume the file content from test-integration.ts
  // line 3: def greet(name: str) -> str:
  // We want to hover "greet".
  const hover = await client.callTool({ 
    name: "python_hover", 
    arguments: {
      file: FIXTURE_PATH,
      line: 2, // 0-based
      column: 4 // "def " is 4 chars
    } 
  });
  console.log("python_hover result:", JSON.stringify(hover, null, 2));

  console.log(`Calling python_definition on ${FIXTURE_PATH}...`);
  const definition = await client.callTool({ 
    name: "python_definition", 
    arguments: {
      file: FIXTURE_PATH,
      line: 22, // print(greet("World")) -> calling greet
      column: 10 // "greet"
    } 
  });
  console.log("python_definition result:", JSON.stringify(definition, null, 2));

  await client.close();
} catch (err) {
  console.error("Test failed:", err);
  process.exit(1);
}