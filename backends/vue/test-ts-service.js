/**
 * Test direct TypeScript service for Vue files
 */

const path = require("path");
const fs = require("fs");

const projectRoot = path.join(__dirname, "test-project");
const testFile = path.join(projectRoot, "src", "App.vue");

// Load TypeScript from project
const ts = require(path.join(projectRoot, "node_modules", "typescript"));

console.log("=== Direct TypeScript Service Test ===");
console.log("Project:", projectRoot);
console.log("Test file:", testFile);
console.log("TypeScript version:", ts.version);

// Try to load Volar packages
let volarCore, volarTypescript;
try {
  volarCore = require(path.join(projectRoot, "node_modules", "@vue", "language-core"));
  console.log("@vue/language-core loaded");
} catch (e) {
  console.log("@vue/language-core not found");
}

try {
  volarTypescript = require(path.join(projectRoot, "node_modules", "@volar", "typescript"));
  console.log("@volar/typescript loaded");
} catch (e) {
  console.log("@volar/typescript not found");
}

// Find tsconfig
const tsconfigPath = fs.existsSync(path.join(projectRoot, "tsconfig.app.json"))
  ? path.join(projectRoot, "tsconfig.app.json")
  : path.join(projectRoot, "tsconfig.json");

console.log("TSConfig:", tsconfigPath);

// Parse tsconfig
const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
  console.error("TSConfig error:", configFile.error);
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  projectRoot,
  undefined,
  tsconfigPath
);

console.log("Files in project:", parsedConfig.fileNames.length);
console.log("Vue files:", parsedConfig.fileNames.filter(f => f.endsWith('.vue')).length);

// If no files found, manually add the test file
if (parsedConfig.fileNames.length === 0) {
  console.log("No files found, manually adding test file");
  parsedConfig.fileNames.push(testFile);
}

// Create document registry and language service host
const documentRegistry = ts.createDocumentRegistry();
const fileContents = new Map();

const host = {
  getScriptFileNames: () => parsedConfig.fileNames,
  getScriptVersion: () => "1",
  getScriptSnapshot: (fileName) => {
    let content = fileContents.get(fileName);
    if (content === undefined) {
      if (fs.existsSync(fileName)) {
        content = fs.readFileSync(fileName, "utf-8");
        fileContents.set(fileName, content);
      } else {
        return undefined;
      }
    }
    return ts.ScriptSnapshot.fromString(content);
  },
  getCurrentDirectory: () => projectRoot,
  getCompilationSettings: () => parsedConfig.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

// Create language service
let languageService;

if (volarCore && volarTypescript) {
  console.log("\n--- Creating Volar-enhanced service ---");
  try {
    // Parse Vue options from tsconfig
    const vueOptions = volarCore.createParsedCommandLine(ts, ts.sys, tsconfigPath).vueOptions;
    console.log("Vue options target:", vueOptions.target);

    // Create Vue language plugin
    const languagePlugin = volarCore.createVueLanguagePlugin(
      ts,
      parsedConfig.options,
      vueOptions,
      (id) => id
    );

    // Create language
    const language = volarCore.createLanguage(
      [languagePlugin],
      new Map(),
      () => {}
    );

    // Create base service
    const baseService = ts.createLanguageService(host, documentRegistry);
    console.log("Base service methods:", Object.keys(baseService).slice(0, 10));

    // Create proxy service - returns { initialize, proxy }
    const proxyResult = volarTypescript.createProxyLanguageService(baseService);
    console.log("Proxy result keys:", Object.keys(proxyResult));

    // Initialize with language
    proxyResult.initialize(language);

    // Use the proxy as the language service
    languageService = proxyResult.proxy;
    console.log("Volar-enhanced service created!");
    console.log("Proxy service methods:", Object.keys(languageService).slice(0, 10));
  } catch (error) {
    console.error("Failed to create Volar service:", error);
    languageService = ts.createLanguageService(host, documentRegistry);
    console.log("Falling back to plain TypeScript service");
  }
} else {
  languageService = ts.createLanguageService(host, documentRegistry);
  console.log("\n--- Using plain TypeScript service ---");
}

// Test hover on App.vue line 11, column 10 (ref import)
console.log("\n--- Testing hover ---");

const content = fs.readFileSync(testFile, "utf-8");
const lines = content.split("\n");

// Line 11 is: import { ref, computed } from 'vue'
// Column 10 is around 'ref'
const targetLine = 11;
const targetColumn = 10;

console.log(`Target: line ${targetLine}, column ${targetColumn}`);
console.log(`Line content: "${lines[targetLine - 1]}"`);

// Calculate offset
let offset = 0;
for (let i = 0; i < targetLine - 1; i++) {
  offset += lines[i].length + 1; // +1 for newline
}
offset += targetColumn - 1;

console.log(`Offset: ${offset}`);

// Get quick info
const info = languageService.getQuickInfoAtPosition(testFile, offset);

if (info) {
  console.log("\n=== HOVER RESULT ===");
  if (info.displayParts) {
    console.log("Display:", info.displayParts.map(p => p.text).join(""));
  }
  if (info.documentation) {
    console.log("Documentation:", info.documentation.map(d => d.text).join("\n"));
  }
  console.log("Kind:", info.kind);
  console.log("KindModifiers:", info.kindModifiers);
} else {
  console.log("\n=== NO HOVER INFO ===");
}

// Test definition
console.log("\n--- Testing definition ---");
const definitions = languageService.getDefinitionAtPosition(testFile, offset);
if (definitions && definitions.length > 0) {
  console.log("Definitions found:", definitions.length);
  for (const def of definitions) {
    console.log(`  - ${def.fileName}:${def.textSpan.start}`);
  }
} else {
  console.log("No definitions found");
}

console.log("\n=== Done ===");
