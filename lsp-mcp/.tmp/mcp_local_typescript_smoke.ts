import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "inherit",
});

const client = new Client(
  { name: "mcp-smoke-ts", version: "0.0.1" },
  { capabilities: {} }
);

const FIXTURE_PATH = path.resolve(process.cwd(), "..", "test-fixtures", "test_sample.ts");

try {
  console.log("Connecting...");
  await client.connect(transport);
  
  console.log("Calling typescript_status...");
  // typescript_status requires a file argument to know which project to check
  const status = await client.callTool({ 
    name: "typescript_status", 
    arguments: { file: FIXTURE_PATH } 
  });
  console.log("typescript_status OK");

  console.log(`Calling typescript_hover on ${FIXTURE_PATH}...`);
  // Content: export function greet(name: string): string {
  // Line 5 (0-indexed 4): export function greet...
  const hover = await client.callTool({ 
    name: "typescript_hover", 
    arguments: {
      file: FIXTURE_PATH,
      line: 4, // 0-based
      column: 16 // "export function " is 16 chars
    } 
  });
  console.log("typescript_hover result:", JSON.stringify(hover, null, 2));

  console.log(`Calling typescript_definition on ${FIXTURE_PATH}...`);
  const definition = await client.callTool({ 
    name: "typescript_definition", 
    arguments: {
      file: FIXTURE_PATH,
      line: 16, // console.log(greet("World")); -> calling greet
      column: 12 // "greet"
    } 
  });
  console.log("typescript_definition result:", JSON.stringify(definition, null, 2));

  await client.close();
} catch (err) {
  console.error("Test failed:", err);
  process.exit(1);
}
