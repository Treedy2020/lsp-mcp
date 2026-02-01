import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "pipe",
});

const client = new Client(
  { name: "mcp-smoke", version: "0.0.1" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`connected; tools=${tools.tools.length}`);
  console.log(tools.tools.map((t) => t.name).slice(0, 5));
  await client.close();
} catch (err) {
  console.error("connect failed:", err);
  process.exit(1);
}
