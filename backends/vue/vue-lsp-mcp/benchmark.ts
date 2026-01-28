#!/usr/bin/env bun
/**
 * Vue LSP MCP Benchmark
 *
 * Tests correctness and performance of vue-lsp-mcp features:
 * - Hover (type info)
 * - Definition (including cross-file)
 * - References (cross-file)
 * - Completions
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as readline from "readline";

const TEST_PROJECT = path.join(import.meta.dir, "../test-project");
const APP_VUE = path.join(TEST_PROJECT, "src/App.vue");
const HELLO_WORLD_VUE = path.join(TEST_PROJECT, "src/components/HelloWorld.vue");
const USER_INFO_VUE = path.join(TEST_PROJECT, "src/components/UserInfo.vue");

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

interface TestCase {
  name: string;
  tool: string;
  args: Record<string, any>;
  validate: (result: any) => { pass: boolean; message: string };
}

class McpClient {
  private process: ChildProcess;
  private messageId = 0;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
  private buffer = "";
  private ready = false;

  constructor() {
    this.process = spawn("bun", [path.join(import.meta.dir, "dist/index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => {
      try {
        const message = JSON.parse(line) as McpResponse;
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          const { resolve, reject } = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      // Uncomment for debugging:
      // console.error("[MCP]", data.toString().trim());
    });
  }

  async initialize(): Promise<void> {
    const result = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "benchmark", version: "1.0" },
    });
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const result = await this.send("tools/call", { name, arguments: args });
    if (result?.content?.[0]?.text) {
      return JSON.parse(result.content[0].text);
    }
    return null;
  }

  private send(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.pendingRequests.set(id, { resolve, reject });
      this.process.stdin?.write(message + "\n");

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });
  }

  close(): void {
    this.process.kill();
  }
}

// Test cases
const testCases: TestCase[] = [
  // ========== Hover Tests ==========
  {
    name: "Hover: Vue ref import",
    tool: "hover",
    args: { file: APP_VUE, line: 11, column: 10 },
    validate: (result) => {
      const pass = result?.contents?.includes("function ref<T>");
      return { pass, message: pass ? "Correct ref type" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Hover: Local variable (title)",
    tool: "hover",
    args: { file: APP_VUE, line: 14, column: 7 },
    validate: (result) => {
      const pass = result?.contents?.includes("Ref<string");
      return { pass, message: pass ? "Correct Ref<string> type" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Hover: Computed variable",
    tool: "hover",
    args: { file: APP_VUE, line: 17, column: 7 },
    validate: (result) => {
      const pass = result?.contents?.includes("ComputedRef<string>");
      return { pass, message: pass ? "Correct ComputedRef type" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Hover: Function",
    tool: "hover",
    args: { file: APP_VUE, line: 19, column: 10 },
    validate: (result) => {
      const pass = result?.contents?.includes("function increment");
      return { pass, message: pass ? "Correct function signature" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Hover: Imported component",
    tool: "hover",
    args: { file: APP_VUE, line: 12, column: 10 },
    validate: (result) => {
      const pass = result?.contents?.includes("HelloWorld") || result?.contents?.includes("DefineComponent");
      return { pass, message: pass ? "Correct component type" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Hover: Cross-file ref variable (Ref<User>)",
    tool: "hover",
    args: { file: HELLO_WORLD_VUE, line: 22, column: 7 },
    validate: (result) => {
      // Should return Ref<User> type
      const hasRef = result?.contents?.includes("Ref<User>") || result?.contents?.includes("Ref<");
      const hasUser = result?.contents?.includes("User");
      const pass = hasRef || hasUser;
      return {
        pass,
        message: pass ? "Correct Ref<User> type" : `Wrong type: ${result?.contents}`
      };
    },
  },

  // ========== Definition Tests ==========
  {
    name: "Definition: Vue ref import -> vue source",
    tool: "definition",
    args: { file: APP_VUE, line: 11, column: 10 },
    validate: (result) => {
      const locations = Array.isArray(result) ? result : [result];
      const pass = locations.some((loc: any) => loc?.file?.includes("@vue/reactivity") || loc?.file?.includes("vue"));
      return { pass, message: pass ? "Jumps to Vue source" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Definition: Cross-file component import (identifier)",
    tool: "definition",
    args: { file: APP_VUE, line: 12, column: 10 }, // Click on HelloWorld identifier
    validate: (result) => {
      const locations = Array.isArray(result) ? result : [result];
      const pass = locations.some((loc: any) => loc?.file?.includes("HelloWorld.vue"));
      return { pass, message: pass ? "Jumps to HelloWorld.vue" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Definition: Cross-file nested component (identifier)",
    tool: "definition",
    args: { file: HELLO_WORLD_VUE, line: 10, column: 10 }, // Click on UserInfo identifier
    validate: (result) => {
      const locations = Array.isArray(result) ? result : [result];
      const pass = locations.some((loc: any) => loc?.file?.includes("UserInfo.vue"));
      return { pass, message: pass ? "Jumps to UserInfo.vue" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },
  {
    name: "Definition: Local variable",
    tool: "definition",
    args: { file: APP_VUE, line: 20, column: 3 },
    validate: (result) => {
      const locations = Array.isArray(result) ? result : [result];
      const pass = locations.some((loc: any) => loc?.file?.includes("App.vue") && loc?.line === 15);
      return { pass, message: pass ? "Jumps to count definition" : `Unexpected: ${JSON.stringify(result)}` };
    },
  },

  // ========== References Tests ==========
  {
    name: "References: Local variable (count) in same file",
    tool: "references",
    args: { file: APP_VUE, line: 15, column: 7 },
    validate: (result) => {
      const refs = result?.references || [];
      const pass = refs.length >= 2; // Definition + usage in increment()
      return { pass, message: pass ? `Found ${refs.length} references` : `Too few references: ${refs.length}` };
    },
  },
  {
    name: "References: Function (increment)",
    tool: "references",
    args: { file: APP_VUE, line: 19, column: 10 },
    validate: (result) => {
      const refs = result?.references || [];
      const pass = refs.length >= 1;
      return { pass, message: pass ? `Found ${refs.length} references` : `No references found` };
    },
  },

  // ========== Completions Tests ==========
  {
    name: "Completions: After 'ref.'",
    tool: "completions",
    args: { file: APP_VUE, line: 20, column: 9 },
    validate: (result) => {
      const items = result?.completions || [];
      const hasValue = items.some((item: any) => item.name === "value");
      return { pass: hasValue, message: hasValue ? "Has 'value' completion" : `Missing 'value': ${JSON.stringify(items.slice(0, 5))}` };
    },
  },
  {
    name: "Completions: Import suggestions",
    tool: "completions",
    args: { file: HELLO_WORLD_VUE, line: 9, column: 22 },
    validate: (result) => {
      const items = result?.completions || [];
      const pass = items.length > 0;
      return { pass, message: pass ? `Got ${items.length} completions` : "No completions" };
    },
  },
];

// Benchmark runner
async function runBenchmarks() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║              Vue LSP MCP Benchmark                             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const client = new McpClient();

  try {
    console.log("Initializing MCP server...");
    const initStart = performance.now();
    await client.initialize();
    const initTime = performance.now() - initStart;
    console.log(`✓ Server initialized in ${initTime.toFixed(0)}ms\n`);

    // Warm up - first request is always slower
    console.log("Warming up (first request)...");
    const warmupStart = performance.now();
    await client.callTool("hover", { file: APP_VUE, line: 11, column: 10 });
    const warmupTime = performance.now() - warmupStart;
    console.log(`✓ Warmup completed in ${warmupTime.toFixed(0)}ms\n`);

    console.log("Running tests...\n");
    console.log("─".repeat(70));

    const results: Array<{ name: string; pass: boolean; time: number; message: string }> = [];

    for (const testCase of testCases) {
      const start = performance.now();
      try {
        const result = await client.callTool(testCase.tool, testCase.args);
        const time = performance.now() - start;
        const validation = testCase.validate(result);

        results.push({
          name: testCase.name,
          pass: validation.pass,
          time,
          message: validation.message,
        });

        const status = validation.pass ? "✓" : "✗";
        const timeStr = `${time.toFixed(0)}ms`.padStart(6);
        console.log(`${status} [${timeStr}] ${testCase.name}`);
        if (!validation.pass) {
          console.log(`           └─ ${validation.message}`);
        }
      } catch (error) {
        const time = performance.now() - start;
        results.push({
          name: testCase.name,
          pass: false,
          time,
          message: String(error),
        });
        console.log(`✗ [${time.toFixed(0)}ms] ${testCase.name}`);
        console.log(`           └─ Error: ${error}`);
      }
    }

    console.log("─".repeat(70));

    // Summary
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    const totalTime = results.reduce((sum, r) => sum + r.time, 0);
    const avgTime = totalTime / results.length;

    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                         Summary                                ║");
    console.log("╠════════════════════════════════════════════════════════════════╣");
    console.log(`║  Total tests:    ${results.length.toString().padStart(3)}                                           ║`);
    console.log(`║  Passed:         ${passed.toString().padStart(3)} (${((passed / results.length) * 100).toFixed(0)}%)                                       ║`);
    console.log(`║  Failed:         ${failed.toString().padStart(3)}                                           ║`);
    console.log(`║  Total time:     ${totalTime.toFixed(0).padStart(5)}ms                                       ║`);
    console.log(`║  Average time:   ${avgTime.toFixed(0).padStart(5)}ms per test                               ║`);
    console.log("╚════════════════════════════════════════════════════════════════╝");

    // Performance breakdown by feature
    console.log("\n┌────────────────────────────────────────────────────────────────┐");
    console.log("│                    Performance by Feature                      │");
    console.log("├────────────────────────────────────────────────────────────────┤");

    const features = ["Hover", "Definition", "References", "Completions"];
    for (const feature of features) {
      const featureResults = results.filter((r) => r.name.startsWith(feature));
      if (featureResults.length > 0) {
        const featureTime = featureResults.reduce((sum, r) => sum + r.time, 0);
        const featureAvg = featureTime / featureResults.length;
        const featurePassed = featureResults.filter((r) => r.pass).length;
        console.log(
          `│  ${feature.padEnd(12)} ${featurePassed}/${featureResults.length} passed   avg: ${featureAvg.toFixed(0).padStart(5)}ms                    │`
        );
      }
    }
    console.log("└────────────────────────────────────────────────────────────────┘");

    process.exit(failed > 0 ? 1 : 0);
  } finally {
    client.close();
  }
}

runBenchmarks().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
