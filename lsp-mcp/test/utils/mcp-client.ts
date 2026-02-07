import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { createInterface } from "readline";

export class McpTestClient {
  private process: ChildProcess;
  private requestId = 0;
  private pendingRequests = new Map<number, (result: any) => void>();
  public notifications: any[] = [];

  constructor(serverPath: string, options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
    const preferredServerPath = this.resolveServerPath(serverPath);
    const isTypeScriptEntry = preferredServerPath.endsWith(".ts");
    const command = isTypeScriptEntry ? "bun" : "node";
    const args = isTypeScriptEntry ? ["run", preferredServerPath] : [preferredServerPath];

    // Default to strict bundled mode for integration tests.
    const env = {
      ...process.env,
      LSP_MCP_REQUIRE_BUNDLED_BACKENDS: process.env.LSP_MCP_REQUIRE_BUNDLED_BACKENDS ?? "true",
      ...options.env,
      PATH: process.env.PATH,
    };

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"], // inherit stderr for logs
      env,
      cwd: options.cwd
    });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
            // Response
            if (this.pendingRequests.has(msg.id)) {
                this.pendingRequests.get(msg.id)!(msg);
                this.pendingRequests.delete(msg.id);
            }
        } else {
            // Notification or Request from server
            this.notifications.push(msg);
        }
      } catch (e) {
        // ignore non-json lines
      }
    });
  }

  private resolveServerPath(serverPath: string): string {
    // Prefer local build output so tests exercise bundled behavior.
    // Can be disabled by setting LSP_MCP_TEST_USE_DIST=false.
    if ((process.env.LSP_MCP_TEST_USE_DIST ?? "true").toLowerCase() !== "false") {
      const distCandidate = path.resolve(path.dirname(serverPath), "..", "dist", "index.js");
      if (fs.existsSync(distCandidate)) {
        return distCandidate;
      }
    }
    return serverPath;
  }

  async request(method: string, params?: any): Promise<any> {
    const id = this.requestId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 60000); // 60s timeout for slow backend starts

      this.pendingRequests.set(id, (response) => {
        clearTimeout(timeout);
        if (response.error) reject(response.error);
        else resolve(response.result);
      });

      this.process.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  async callTool(name: string, args: any): Promise<any> {
    const res = await this.request("tools/call", { name, arguments: args });
    // MCP tool call returns { content: [...] }
    try {
        return JSON.parse(res.content[0].text);
    } catch (e) {
        return res.content[0].text;
    }
  }

  kill() {
    this.process.kill();
  }
}
