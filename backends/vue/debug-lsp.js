#!/usr/bin/env node
/**
 * Debug script for Vue Language Server LSP communication
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Configuration
const projectRoot = process.argv[2] || "/Users/treedy/Project/PyLspMcp/backends/vue/test-project";
const testFile = process.argv[3] || path.join(projectRoot, "src/App.vue");
const testLine = parseInt(process.argv[4] || "14");
const testColumn = parseInt(process.argv[5] || "7");

console.log("=== Vue Language Server Debug ===");
console.log("Project:", projectRoot);
console.log("File:", testFile);
console.log("Position:", testLine, ":", testColumn);
console.log("");

// Find vue-language-server
const vueServerPath = path.join(projectRoot, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js");
if (!fs.existsSync(vueServerPath)) {
  console.error("ERROR: @vue/language-server not found at", vueServerPath);
  process.exit(1);
}

// Find TypeScript SDK
const tsSdkPath = path.join(projectRoot, "node_modules", "typescript", "lib");
console.log("Vue Server:", vueServerPath);
console.log("TS SDK:", tsSdkPath);
console.log("");

// Spawn server with tsdk argument
const proc = spawn("node", [vueServerPath, "--stdio", `--tsdk=${tsSdkPath}`], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"],
});
console.log("Args:", ["--stdio", `--tsdk=${tsSdkPath}`]);
console.log("");

let buffer = "";
let messageId = 0;
const pendingRequests = new Map();

// Parse LSP messages
function parseMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length: (\d+)/);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;

    if (buffer.length < messageEnd) break;

    const messageStr = buffer.substring(messageStart, messageEnd);
    buffer = buffer.substring(messageEnd);

    try {
      const message = JSON.parse(messageStr);
      handleMessage(message);
    } catch (e) {
      console.error("Parse error:", e);
    }
  }
}

// Handle incoming message
function handleMessage(message) {
  // Response
  if (message.id !== undefined && !message.method) {
    console.log(`<-- Response id=${message.id}`, message.error ? `ERROR: ${message.error.message}` : "OK");
    if (pendingRequests.has(message.id)) {
      const { resolve, name } = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      resolve(message);

      // Log result details for hover
      if (name === "textDocument/hover" && message.result) {
        console.log("    Hover contents:", JSON.stringify(message.result.contents).slice(0, 200));
      }
    }
    return;
  }

  // Server request (has id and method)
  if (message.id !== undefined && message.method) {
    console.log(`<-- Server Request id=${message.id} method=${message.method}`);

    // Handle workspace/configuration
    if (message.method === "workspace/configuration") {
      const items = message.params?.items || [];
      console.log("    Items:", items.length, items.map(i => i.section).join(", "));
      sendResponse(message.id, items.map(() => ({})));
    }
    // Handle client/registerCapability
    else if (message.method === "client/registerCapability") {
      sendResponse(message.id, null);
    }
    // Handle window/workDoneProgress/create
    else if (message.method === "window/workDoneProgress/create") {
      sendResponse(message.id, null);
    }
    else {
      console.log("    (unhandled server request)");
    }
    return;
  }

  // Notification
  if (message.method) {
    console.log(`<-- Notification method=${message.method}`);
    if (message.method === "$/progress") {
      const token = message.params?.token;
      const kind = message.params?.value?.kind;
      const title = message.params?.value?.title || "";
      const msg = message.params?.value?.message || "";
      console.log(`    Progress [${token}] ${kind}: ${title} ${msg}`);
    } else if (message.method === "tsserver/request") {
      // tsserver/request format: [[id, command, args]]
      const requests = message.params;
      console.log(`    tsserver request:`, JSON.stringify(requests).slice(0, 500));

      // We need to respond to these requests via tsserver/response
      for (const [id, command, args] of requests) {
        console.log(`    Processing tsserver request id=${id} command=${command}`);

        // Handle different tsserver commands
        let result = null;

        if (command === "_vue:projectInfo") {
          // Return project info with the tsconfig path
          const tsconfigApp = path.join(projectRoot, "tsconfig.app.json");
          const tsconfig = path.join(projectRoot, "tsconfig.json");
          const configFile = fs.existsSync(tsconfigApp) ? tsconfigApp : tsconfig;
          result = { configFileName: configFile };
          console.log(`    -> projectInfo:`, result.configFileName);
        } else {
          // For other commands, return null or empty
          console.log(`    -> Unhandled command, returning null`);
          result = null;
        }

        // Send tsserver/response with [[id, result]] format
        sendNotification("tsserver/response", [[id, result]]);
      }
    } else {
      // Log other notifications
      console.log(`    params:`, JSON.stringify(message.params).slice(0, 200));
    }
  }
}

// Send request
function sendRequest(method, params) {
  return new Promise((resolve) => {
    const id = ++messageId;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    pendingRequests.set(id, { resolve, name: method });
    console.log(`--> Request id=${id} method=${method}`);
    proc.stdin.write(content);
  });
}

// Send response
function sendResponse(id, result) {
  const message = JSON.stringify({ jsonrpc: "2.0", id, result });
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  console.log(`--> Response id=${id}`);
  proc.stdin.write(content);
}

// Send notification
function sendNotification(method, params) {
  const message = JSON.stringify({ jsonrpc: "2.0", method, params });
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  console.log(`--> Notification method=${method}`);
  if (method === "tsserver/response") {
    console.log(`    Full message: ${message}`);
  }
  proc.stdin.write(content);
}

// Handle stdout
proc.stdout.on("data", (data) => {
  buffer += data.toString();
  parseMessages();
});

// Handle stderr
proc.stderr.on("data", (data) => {
  console.error("[SERVER STDERR]", data.toString().trim());
});

proc.on("error", (err) => {
  console.error("Process error:", err);
});

proc.on("exit", (code) => {
  console.log("Server exited with code:", code);
});

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main test sequence
async function main() {
  console.log("\n=== Step 1: Initialize ===");
  const initResult = await sendRequest("initialize", {
    processId: process.pid,
    rootUri: `file://${projectRoot}`,
    rootPath: projectRoot,
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["markdown", "plaintext"] },
        completion: { completionItem: { snippetSupport: true } },
        definition: {},
        references: {},
      },
      workspace: {
        configuration: true,
        workspaceFolders: true,
      },
    },
    initializationOptions: {
      typescript: { tsdk: tsSdkPath },
      vue: { hybridMode: false },
    },
    workspaceFolders: [
      { uri: `file://${projectRoot}`, name: path.basename(projectRoot) },
    ],
  });

  console.log("\n=== Step 2: Initialized notification ===");
  sendNotification("initialized", {});

  console.log("\n=== Step 3: Wait for server to be ready ===");
  await sleep(3000);

  console.log("\n=== Step 4: Open document ===");
  const fileContent = fs.readFileSync(testFile, "utf-8");
  sendNotification("textDocument/didOpen", {
    textDocument: {
      uri: `file://${testFile}`,
      languageId: "vue",
      version: 1,
      text: fileContent,
    },
  });

  console.log("\n=== Step 5: Wait for document to be processed (5 seconds) ===");
  await sleep(5000);

  console.log("\n=== Step 6: Wait more for server ===");
  await sleep(3000);

  console.log("\n=== Step 7: Send hover request ===");
  const hoverResult = await sendRequest("textDocument/hover", {
    textDocument: { uri: `file://${testFile}` },
    position: { line: testLine - 1, character: testColumn - 1 },
  });

  console.log("\n=== Step 8: Wait for any delayed responses ===");
  await sleep(2000);

  console.log("\n=== Result ===");
  console.log(JSON.stringify(hoverResult, null, 2));

  console.log("\n=== Step 7: Cleanup ===");
  proc.kill();
}

// Run with timeout
const timeout = setTimeout(() => {
  console.log("\n=== TIMEOUT after 45 seconds ===");
  console.log("Pending requests:", Array.from(pendingRequests.keys()));
  proc.kill();
  process.exit(1);
}, 45000);

main().then(() => {
  clearTimeout(timeout);
  process.exit(0);
}).catch((err) => {
  console.error("Error:", err);
  clearTimeout(timeout);
  proc.kill();
  process.exit(1);
});
