/**
 * Debug script to test Vue Language Server with tsserver integration
 * for Volar 3.x support
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const projectRoot = path.join(__dirname, "test-project");
const testFile = path.join(projectRoot, "src", "App.vue");

// Find paths
const vueServerPath = path.join(projectRoot, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js");
const tsserverPath = path.join(projectRoot, "node_modules", "typescript", "lib", "tsserver.js");
const tsSdkPath = path.join(projectRoot, "node_modules", "typescript", "lib");
const vuePluginPath = path.join(projectRoot, "node_modules", "@vue", "typescript-plugin");

console.log("=== Vue LSP + tsserver Debug ===");
console.log("Project root:", projectRoot);
console.log("Vue server:", fs.existsSync(vueServerPath) ? "OK" : "NOT FOUND");
console.log("TypeScript server:", fs.existsSync(tsserverPath) ? "OK" : "NOT FOUND");
console.log("Vue TS plugin:", fs.existsSync(vuePluginPath) ? "OK" : "NOT FOUND");
console.log("");

// Spawn Vue Language Server
const vueServer = spawn("node", [vueServerPath, "--stdio"], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

// Spawn TypeScript Server
const tsserver = spawn("node", [tsserverPath], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

let vueBuffer = "";
let tsBuffer = "";
let messageId = 0;
let tsSeq = 0;

// Pending requests
const vuePending = new Map();
const tsPending = new Map(); // Maps tsserver seq -> volar id

// Parse Vue LSP messages
function parseVueMessages() {
  while (true) {
    const headerEnd = vueBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = vueBuffer.substring(0, headerEnd);
    const match = header.match(/Content-Length: (\d+)/);
    if (!match) break;

    const length = parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;

    if (vueBuffer.length < end) break;

    const messageStr = vueBuffer.substring(start, end);
    vueBuffer = vueBuffer.substring(end);

    try {
      const message = JSON.parse(messageStr);
      handleVueMessage(message);
    } catch (e) {
      console.error("Parse error:", e);
    }
  }
}

// Parse tsserver messages
function parseTsMessages() {
  const lines = tsBuffer.split("\n");
  tsBuffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim() || line.startsWith("Content-Length")) continue;
    try {
      const message = JSON.parse(line);
      handleTsMessage(message);
    } catch {
      // Ignore non-JSON lines
    }
  }
}

// Handle Vue LSP message
function handleVueMessage(message) {
  // Response to our request
  if (message.id !== undefined && vuePending.has(message.id)) {
    const { resolve } = vuePending.get(message.id);
    vuePending.delete(message.id);
    const resultStr = JSON.stringify(message.result ?? message.error ?? null);
    console.log(`[Vue] Response id=${message.id}:`, resultStr.slice(0, 200));
    resolve(message.result);
    return;
  }

  // Server request (has id and method)
  if (message.id !== undefined && message.method) {
    console.log(`[Vue] Server request: ${message.method}`);

    if (message.method === "workspace/configuration") {
      sendVueResponse(message.id, message.params?.items?.map(() => ({})) || []);
    } else if (message.method === "client/registerCapability" || message.method === "window/workDoneProgress/create") {
      sendVueResponse(message.id, null);
    }
    return;
  }

  // Notification
  if (message.method && message.id === undefined) {
    if (message.method === "tsserver/request") {
      console.log(`[Vue] tsserver/request:`, JSON.stringify(message.params).slice(0, 300));

      for (const [id, command, args] of message.params) {
        console.log(`  -> id=${id} command=${command}`);

        if (command === "_vue:projectInfo") {
          // Handle locally
          const tsconfig = path.join(projectRoot, "tsconfig.json");
          const result = { configFileName: tsconfig };
          console.log(`  <- projectInfo:`, result.configFileName);
          sendVueNotification("tsserver/response", [[id, result]]);
        } else {
          // Forward to tsserver
          forwardToTsServer(id, command, args);
        }
      }
    } else if (message.method === "textDocument/publishDiagnostics") {
      console.log(`[Vue] Diagnostics for:`, message.params?.uri?.split("/").pop());
    } else if (message.method === "$/progress") {
      // Ignore progress
    } else if (message.method === "window/logMessage") {
      console.log(`[Vue] Log:`, message.params?.message?.slice(0, 300));
    } else {
      console.log(`[Vue] Notification: ${message.method}`, JSON.stringify(message.params).slice(0, 200));
    }
  }
}

// Handle tsserver message
function handleTsMessage(message) {
  console.log(`[TS] Message type=${message.type}:`, JSON.stringify(message).slice(0, 200));

  if (message.type === "response" && message.request_seq !== undefined) {
    const pending = tsPending.get(message.request_seq);
    if (pending) {
      tsPending.delete(message.request_seq);
      console.log(`[TS] Response for volarId=${pending.volarId}:`, JSON.stringify(message.body).slice(0, 200));

      // Send back to Volar
      sendVueNotification("tsserver/response", [[pending.volarId, message.body]]);
    }
  }
}

// Forward command to tsserver
function forwardToTsServer(volarId, command, args) {
  const tsCommand = command.replace(/^_vue:/, "");
  const seq = ++tsSeq;

  tsPending.set(seq, { volarId });

  const request = {
    seq,
    type: "request",
    command: tsCommand,
    arguments: args,
  };

  console.log(`[TS] Forwarding: seq=${seq} command=${tsCommand}`);
  tsserver.stdin.write(JSON.stringify(request) + "\n");
}

// Send response to Vue LSP
function sendVueResponse(id, result) {
  const message = JSON.stringify({ jsonrpc: "2.0", id, result });
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  vueServer.stdin.write(content);
}

// Send notification to Vue LSP
function sendVueNotification(method, params) {
  const message = JSON.stringify({ jsonrpc: "2.0", method, params });
  const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
  vueServer.stdin.write(content);
}

// Send request to Vue LSP
function sendVueRequest(method, params) {
  return new Promise((resolve) => {
    const id = ++messageId;
    vuePending.set(id, { resolve });

    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    console.log(`[Vue] Request id=${id} method=${method}`);
    vueServer.stdin.write(content);

    setTimeout(() => {
      if (vuePending.has(id)) {
        vuePending.delete(id);
        console.log(`[Vue] Request ${id} timed out`);
        resolve(null);
      }
    }, 30000);
  });
}

// Send command to tsserver
function sendTsCommand(command, args) {
  const seq = ++tsSeq;
  const request = { seq, type: "request", command, arguments: args };
  console.log(`[TS] Command: seq=${seq} command=${command}`);
  tsserver.stdin.write(JSON.stringify(request) + "\n");
}

// Setup event handlers
vueServer.stdout.on("data", (data) => {
  vueBuffer += data.toString();
  parseVueMessages();
});

vueServer.stderr.on("data", (data) => {
  console.error("[Vue stderr]", data.toString().trim());
});

tsserver.stdout.on("data", (data) => {
  tsBuffer += data.toString();
  parseTsMessages();
});

tsserver.stderr.on("data", (data) => {
  console.error("[TS stderr]", data.toString().trim());
});

// Main test flow
async function main() {
  console.log("\n=== Starting test ===\n");

  // 1. Configure tsserver with Vue plugin
  console.log("1. Configuring tsserver with Vue plugin...");
  sendTsCommand("configure", {
    plugins: [{ name: vuePluginPath }],
    preferences: { includePackageJsonAutoImports: "auto" },
  });

  await sleep(1000);

  // 2. Open files in tsserver (both main.ts and the Vue file)
  console.log("\n2. Opening files in tsserver...");
  const mainTs = path.join(projectRoot, "src", "main.ts");
  if (fs.existsSync(mainTs)) {
    sendTsCommand("open", {
      file: mainTs,
      projectRootPath: projectRoot,
    });
  }

  // Also open the Vue file in tsserver
  console.log("   Opening Vue file in tsserver...");
  sendTsCommand("open", {
    file: testFile,
    fileContent: fs.readFileSync(testFile, "utf-8"),
    projectRootPath: projectRoot,
  });

  await sleep(2000);

  // 3. Initialize Vue LSP
  console.log("\n3. Initializing Vue Language Server...");
  await sendVueRequest("initialize", {
    processId: process.pid,
    rootUri: `file://${projectRoot}`,
    rootPath: projectRoot,
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["plaintext", "markdown"] },
        completion: { completionItem: { snippetSupport: true } },
        definition: {},
        references: {},
        publishDiagnostics: {},
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
    workspaceFolders: [{ uri: `file://${projectRoot}`, name: "test-project" }],
  });

  sendVueNotification("initialized", {});
  console.log("Initialized!");

  await sleep(3000);

  // 4. Open the Vue file
  console.log("\n4. Opening Vue file...");
  const content = fs.readFileSync(testFile, "utf-8");
  sendVueNotification("textDocument/didOpen", {
    textDocument: {
      uri: `file://${testFile}`,
      languageId: "vue",
      version: 1,
      text: content,
    },
  });

  await sleep(5000);

  // 5. Test hover
  console.log("\n5. Testing hover on 'ref' (line 11, column 10)...");
  const hoverResult = await sendVueRequest("textDocument/hover", {
    textDocument: { uri: `file://${testFile}` },
    position: { line: 10, character: 9 }, // 0-based: line 11, column 10
  });

  console.log("\n=== HOVER RESULT ===");
  console.log(JSON.stringify(hoverResult, null, 2));

  // 6. Test definition
  console.log("\n6. Testing definition on 'ref'...");
  const defResult = await sendVueRequest("textDocument/definition", {
    textDocument: { uri: `file://${testFile}` },
    position: { line: 10, character: 9 },
  });

  console.log("\n=== DEFINITION RESULT ===");
  console.log(JSON.stringify(defResult, null, 2));

  // 7. Test tsserver quickinfo directly on the Vue file
  console.log("\n7. Testing tsserver quickinfo directly on Vue file...");
  sendTsCommand("quickinfo", {
    file: testFile,
    line: 11,
    offset: 10,
  });

  await sleep(2000);

  // Cleanup
  console.log("\n=== Done ===");
  setTimeout(() => {
    vueServer.kill();
    tsserver.kill();
    process.exit(0);
  }, 2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
