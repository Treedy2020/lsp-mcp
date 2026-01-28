/**
 * TypeScript Language Service wrapper.
 * Uses the official TypeScript compiler API for code intelligence.
 *
 * Attempts to use the project's local TypeScript installation first,
 * falling back to the bundled version if not found.
 */

import bundledTs from "typescript";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

// Type alias for TypeScript module
type TypeScriptModule = typeof bundledTs;

// Cache for language services per project
const serviceCache = new Map<string, bundledTs.LanguageService>();
const documentVersions = new Map<string, number>();
const documentContents = new Map<string, string>();
// Track files that have been accessed (per project)
const accessedFilesPerProject = new Map<string, Set<string>>();
// Cache for TypeScript modules per project (to use project's local TS)
const tsModuleCache = new Map<string, { ts: TypeScriptModule; version: string; source: "project" | "bundled" }>();
// Cache for parsed configs (for debugging)
const configCache = new Map<string, {
  options: bundledTs.CompilerOptions;
  errors: string[];
  fileNames: string[];
  declarationFiles: string[];
  detectedFrameworks: string[];
  typescriptVersion: string;
  typescriptSource: "project" | "bundled";
}>();

/**
 * Get the TypeScript module to use for a project.
 * Prefers the project's local TypeScript installation.
 */
function getTypeScriptForProject(projectRoot: string): { ts: TypeScriptModule; version: string; source: "project" | "bundled" } {
  // Check cache first
  if (tsModuleCache.has(projectRoot)) {
    return tsModuleCache.get(projectRoot)!;
  }

  // Try to load project's local TypeScript
  const localTsPath = path.join(projectRoot, "node_modules", "typescript");
  if (fs.existsSync(localTsPath)) {
    try {
      // Use createRequire to load from the project's node_modules
      const require = createRequire(path.join(projectRoot, "package.json"));
      const localTs = require("typescript") as TypeScriptModule;
      const result = {
        ts: localTs,
        version: localTs.version,
        source: "project" as const,
      };
      tsModuleCache.set(projectRoot, result);
      console.error(`[ts-service] Using project TypeScript ${localTs.version} from ${localTsPath}`);
      return result;
    } catch (error) {
      console.error(`[ts-service] Failed to load project TypeScript, using bundled:`, error);
    }
  }

  // Fall back to bundled TypeScript
  const result = {
    ts: bundledTs,
    version: bundledTs.version,
    source: "bundled" as const,
  };
  tsModuleCache.set(projectRoot, result);
  console.error(`[ts-service] Using bundled TypeScript ${bundledTs.version} (no local installation found)`);
  return result;
}

/**
 * Register a file as accessed for a project.
 */
function registerFile(projectRoot: string, filePath: string): void {
  if (!accessedFilesPerProject.has(projectRoot)) {
    accessedFilesPerProject.set(projectRoot, new Set());
  }
  accessedFilesPerProject.get(projectRoot)!.add(filePath);
}

/**
 * Find the project root by looking for tsconfig.json
 * Also returns the path to the tsconfig.json file found
 */
export function findProjectRoot(filePath: string): string {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(filePath);
}

/**
 * Find all .d.ts files in the project (excluding node_modules)
 */
function findDeclarationFiles(projectRoot: string): string[] {
  const dtsFiles: string[] = [];

  function scanDir(dir: string, depth: number = 0): void {
    // Limit depth to avoid scanning too deep
    if (depth > 5) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip node_modules, dist, build directories
        if (entry.isDirectory()) {
          if (!["node_modules", "dist", "build", ".git", ".next", ".nuxt"].includes(entry.name)) {
            scanDir(fullPath, depth + 1);
          }
        } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
          dtsFiles.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  scanDir(projectRoot);
  return dtsFiles;
}

/**
 * Detect project frameworks and return relevant type packages to include
 */
function detectFrameworkTypes(projectRoot: string): string[] {
  const types: string[] = [];
  const nodeModulesPath = path.join(projectRoot, "node_modules");

  if (!fs.existsSync(nodeModulesPath)) {
    return types;
  }

  // Check for Vite
  const hasVite = fs.existsSync(path.join(projectRoot, "vite.config.ts")) ||
                  fs.existsSync(path.join(projectRoot, "vite.config.js")) ||
                  fs.existsSync(path.join(projectRoot, "vite.config.mts"));
  if (hasVite && fs.existsSync(path.join(nodeModulesPath, "vite", "client.d.ts"))) {
    types.push("vite/client");
  }

  // Check for Vue
  const hasVue = fs.existsSync(path.join(nodeModulesPath, "vue")) ||
                 fs.existsSync(path.join(projectRoot, "src", "App.vue"));
  if (hasVue) {
    // Vue 3 types
    if (fs.existsSync(path.join(nodeModulesPath, "@vue", "runtime-core"))) {
      // Vue types are usually auto-included, but we ensure they're available
    }
  }

  // Check for React
  const hasReact = fs.existsSync(path.join(nodeModulesPath, "react"));
  if (hasReact && fs.existsSync(path.join(nodeModulesPath, "@types", "react"))) {
    // React types are in @types/react
  }

  // Check for Node.js types
  if (fs.existsSync(path.join(nodeModulesPath, "@types", "node"))) {
    types.push("node");
  }

  return types;
}

/**
 * Get or create a language service for a project.
 */
export function getLanguageService(projectRoot: string): bundledTs.LanguageService {
  if (serviceCache.has(projectRoot)) {
    return serviceCache.get(projectRoot)!;
  }

  // Get TypeScript module for this project (prefers local installation)
  const { ts, version: tsVersion, source: tsSource } = getTypeScriptForProject(projectRoot);

  // Read tsconfig.json if it exists
  const configPath = path.join(projectRoot, "tsconfig.json");
  let compilerOptions: bundledTs.CompilerOptions = {
    target: bundledTs.ScriptTarget.ESNext,
    module: bundledTs.ModuleKind.ESNext,
    moduleResolution: bundledTs.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
  };

  let rootFiles: string[] = [];
  const configErrors: string[] = [];

  // Find all .d.ts files in the project for type declarations
  const projectDtsFiles = findDeclarationFiles(projectRoot);

  if (fs.existsSync(configPath)) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      configErrors.push(`Failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        projectRoot
      );

      // Collect any parsing errors
      if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
          configErrors.push(ts.flattenDiagnosticMessageText(err.messageText, "\n"));
        }
      }

      compilerOptions = parsed.options;
      rootFiles = parsed.fileNames;

      // Auto-detect and add framework types
      const frameworkTypes = detectFrameworkTypes(projectRoot);
      for (const type of frameworkTypes) {
        if (!compilerOptions.types?.includes(type)) {
          compilerOptions.types = [...(compilerOptions.types || []), type];
        }
      }

      // Include project .d.ts files that might not be in rootFiles
      for (const dtsFile of projectDtsFiles) {
        if (!rootFiles.includes(dtsFile)) {
          rootFiles.push(dtsFile);
        }
      }
    }
  } else {
    // No tsconfig.json - include .d.ts files anyway
    rootFiles = [...projectDtsFiles];
  }

  // Detect frameworks for status reporting
  const detectedFrameworks: string[] = [];
  if (fs.existsSync(path.join(projectRoot, "vite.config.ts")) ||
      fs.existsSync(path.join(projectRoot, "vite.config.js")) ||
      fs.existsSync(path.join(projectRoot, "vite.config.mts"))) {
    detectedFrameworks.push("vite");
  }
  if (fs.existsSync(path.join(projectRoot, "vue.config.js")) ||
      fs.existsSync(path.join(projectRoot, "src", "App.vue")) ||
      fs.existsSync(path.join(projectRoot, "node_modules", "vue"))) {
    detectedFrameworks.push("vue");
  }
  // Detect Vue TSX support
  if (fs.existsSync(path.join(projectRoot, "node_modules", "@vitejs", "plugin-vue-jsx")) ||
      fs.existsSync(path.join(projectRoot, "node_modules", "@vue", "babel-plugin-jsx"))) {
    detectedFrameworks.push("vue-tsx");
  }
  if (fs.existsSync(path.join(projectRoot, "next.config.js")) ||
      fs.existsSync(path.join(projectRoot, "next.config.ts"))) {
    detectedFrameworks.push("next");
  }
  if (fs.existsSync(path.join(projectRoot, "nuxt.config.ts")) ||
      fs.existsSync(path.join(projectRoot, "nuxt.config.js"))) {
    detectedFrameworks.push("nuxt");
  }

  // Store config info for debugging
  configCache.set(projectRoot, {
    options: compilerOptions,
    errors: configErrors,
    fileNames: rootFiles,
    declarationFiles: projectDtsFiles,
    detectedFrameworks,
    typescriptVersion: tsVersion,
    typescriptSource: tsSource,
  });

  // Create the language service host (using the project's TypeScript)
  const host: bundledTs.LanguageServiceHost = {
    getScriptFileNames: () => {
      // Include config files, open documents, and accessed files
      const openFiles = Array.from(documentContents.keys()).filter(
        (f) => f.startsWith(projectRoot) && (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"))
      );
      const accessed = accessedFilesPerProject.get(projectRoot);
      const accessedList = accessed ? Array.from(accessed) : [];
      return [...new Set([...rootFiles, ...openFiles, ...accessedList])];
    },
    getScriptVersion: (fileName) => {
      return (documentVersions.get(fileName) || 0).toString();
    },
    getScriptSnapshot: (fileName) => {
      // Check in-memory documents first
      if (documentContents.has(fileName)) {
        return ts.ScriptSnapshot.fromString(documentContents.get(fileName)!);
      }
      // Fall back to disk
      if (!fs.existsSync(fileName)) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
    },
    getCurrentDirectory: () => projectRoot,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: bundledTs.sys.fileExists,
    readFile: bundledTs.sys.readFile,
    readDirectory: bundledTs.sys.readDirectory,
    directoryExists: bundledTs.sys.directoryExists,
    getDirectories: bundledTs.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  serviceCache.set(projectRoot, service);
  return service;
}

/**
 * Get the cached project configuration for debugging.
 */
export function getProjectConfig(projectRoot: string): {
  options: bundledTs.CompilerOptions;
  errors: string[];
  fileNames: string[];
  declarationFiles: string[];
  detectedFrameworks: string[];
  typescriptVersion: string;
  typescriptSource: "project" | "bundled";
} | undefined {
  // Ensure the service is initialized
  getLanguageService(projectRoot);
  return configCache.get(projectRoot);
}

/**
 * Update document content for incremental analysis.
 */
export function updateDocument(filePath: string, content: string): void {
  const absPath = path.resolve(filePath);
  documentContents.set(absPath, content);
  documentVersions.set(absPath, (documentVersions.get(absPath) || 0) + 1);

  // Invalidate the service cache for this project to pick up changes
  const projectRoot = findProjectRoot(absPath);
  serviceCache.delete(projectRoot);
}

/**
 * Convert line/column (1-based) to offset.
 */
export function positionToOffset(
  content: string,
  line: number,
  column: number
): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  offset += column - 1;
  return offset;
}

/**
 * Convert offset to line/column (1-based).
 */
export function offsetToPosition(
  content: string,
  offset: number
): { line: number; column: number } {
  const lines = content.split("\n");
  let currentOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length + 1;
    if (currentOffset + lineLength > offset) {
      return {
        line: i + 1,
        column: offset - currentOffset + 1,
      };
    }
    currentOffset += lineLength;
  }
  return { line: lines.length, column: 1 };
}

/**
 * Get file content from memory or disk.
 */
export function getFileContent(filePath: string): string {
  const absPath = path.resolve(filePath);
  if (documentContents.has(absPath)) {
    return documentContents.get(absPath)!;
  }
  return fs.readFileSync(absPath, "utf-8");
}

/**
 * Get a language service with the file registered.
 */
function getServiceForFile(filePath: string): { service: bundledTs.LanguageService; absPath: string; projectRoot: string } {
  const absPath = path.resolve(filePath);
  const projectRoot = findProjectRoot(absPath);
  registerFile(projectRoot, absPath);
  // Invalidate cache to pick up the new file
  serviceCache.delete(projectRoot);
  const service = getLanguageService(projectRoot);
  return { service, absPath, projectRoot };
}

/**
 * Get quick info (hover) at a position.
 */
export function getQuickInfo(
  filePath: string,
  line: number,
  column: number
): bundledTs.QuickInfo | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getQuickInfoAtPosition(absPath, offset);
}

/**
 * Get definition location.
 */
export function getDefinition(
  filePath: string,
  line: number,
  column: number
): readonly bundledTs.DefinitionInfo[] | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getDefinitionAtPosition(absPath, offset);
}

/**
 * Get references.
 */
export function getReferences(
  filePath: string,
  line: number,
  column: number
): bundledTs.ReferenceEntry[] | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getReferencesAtPosition(absPath, offset);
}

/**
 * Get completions.
 */
export function getCompletions(
  filePath: string,
  line: number,
  column: number
): bundledTs.CompletionInfo | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getCompletionsAtPosition(absPath, offset, undefined);
}

/**
 * Get signature help.
 */
export function getSignatureHelp(
  filePath: string,
  line: number,
  column: number
): bundledTs.SignatureHelpItems | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getSignatureHelpItems(absPath, offset, undefined);
}

/**
 * Get document symbols.
 */
export function getDocumentSymbols(filePath: string): bundledTs.NavigationTree {
  const { service, absPath } = getServiceForFile(filePath);
  return service.getNavigationTree(absPath);
}

/**
 * Get diagnostics.
 */
export function getDiagnostics(filePath: string): bundledTs.Diagnostic[] {
  const { service, absPath } = getServiceForFile(filePath);

  const syntactic = service.getSyntacticDiagnostics(absPath);
  const semantic = service.getSemanticDiagnostics(absPath);
  const suggestion = service.getSuggestionDiagnostics(absPath);

  return [...syntactic, ...semantic, ...suggestion];
}

/**
 * Get rename locations.
 */
export function getRenameLocations(
  filePath: string,
  line: number,
  column: number
): readonly bundledTs.RenameLocation[] | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);

  const renameInfo = service.getRenameInfo(absPath, offset, {});
  if (!renameInfo.canRename) {
    return undefined;
  }

  return service.findRenameLocations(absPath, offset, false, false);
}

/**
 * Format diagnostic message.
 */
export function formatDiagnostic(diag: bundledTs.Diagnostic): {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  code: number;
} {
  const message = bundledTs.flattenDiagnosticMessageText(diag.messageText, "\n");
  const severity =
    diag.category === bundledTs.DiagnosticCategory.Error
      ? "error"
      : diag.category === bundledTs.DiagnosticCategory.Warning
      ? "warning"
      : "info";

  if (diag.file && diag.start !== undefined) {
    const { line, character } = diag.file.getLineAndCharacterOfPosition(
      diag.start
    );
    return {
      file: diag.file.fileName,
      line: line + 1,
      column: character + 1,
      severity,
      message,
      code: diag.code,
    };
  }

  return {
    file: "",
    line: 0,
    column: 0,
    severity,
    message,
    code: diag.code,
  };
}

/**
 * Display parts to string.
 */
export function displayPartsToString(
  parts: bundledTs.SymbolDisplayPart[] | undefined
): string {
  if (!parts) return "";
  return parts.map((p) => p.text).join("");
}

/**
 * Get applicable refactorings at a position.
 */
export function getApplicableRefactors(
  filePath: string,
  line: number,
  column: number
): bundledTs.ApplicableRefactorInfo[] {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getApplicableRefactors(absPath, offset, {}) || [];
}

/**
 * Get edits for a refactoring.
 */
export function getRefactorEdits(
  filePath: string,
  line: number,
  column: number,
  refactorName: string,
  actionName: string
): bundledTs.RefactorEditInfo | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getEditsForRefactor(absPath, {}, offset, refactorName, actionName, {});
}

/**
 * Get function signature at a position.
 */
export function getFunctionSignature(
  filePath: string,
  line: number,
  column: number
): {
  name: string;
  parameters: Array<{ name: string; type: string; optional: boolean; defaultValue?: string }>;
  returnType: string;
  kind: string;
} | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);

  // Get the quick info to find the function
  const info = service.getQuickInfoAtPosition(absPath, offset);
  if (!info) return undefined;

  // Check if it's a function/method
  if (info.kind !== bundledTs.ScriptElementKind.functionElement &&
      info.kind !== bundledTs.ScriptElementKind.memberFunctionElement &&
      info.kind !== bundledTs.ScriptElementKind.constructorImplementationElement &&
      info.kind !== bundledTs.ScriptElementKind.callSignatureElement) {
    return undefined;
  }

  // Parse the display string to extract parameters
  const displayString = displayPartsToString(info.displayParts);

  // Extract function name
  const nameMatch = displayString.match(/^(?:function\s+)?(\w+)/);
  const name = nameMatch ? nameMatch[1] : "anonymous";

  // Extract parameters from between parentheses
  const paramsMatch = displayString.match(/\(([^)]*)\)/);
  const paramsStr = paramsMatch ? paramsMatch[1] : "";

  const parameters: Array<{ name: string; type: string; optional: boolean; defaultValue?: string }> = [];

  if (paramsStr.trim()) {
    // Split by comma but be careful with generics
    let depth = 0;
    let current = "";
    const parts: string[] = [];

    for (const char of paramsStr) {
      if (char === "<" || char === "(") depth++;
      else if (char === ">" || char === ")") depth--;
      else if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim()) parts.push(current.trim());

    for (const param of parts) {
      const optional = param.includes("?:");
      const [paramName, ...typeParts] = param.split(/\??:/);
      const type = typeParts.join(":").trim() || "any";

      parameters.push({
        name: paramName.trim(),
        type,
        optional,
      });
    }
  }

  // Extract return type
  const returnMatch = displayString.match(/\):\s*(.+)$/);
  const returnType = returnMatch ? returnMatch[1].trim() : "void";

  return {
    name,
    parameters,
    returnType,
    kind: info.kind,
  };
}

/**
 * Apply file changes to disk.
 */
export function applyFileChanges(
  changes: bundledTs.FileTextChanges[]
): { changedFiles: string[]; created: string[]; deleted: string[] } {
  const changedFiles: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];

  for (const fileChange of changes) {
    const filePath = fileChange.fileName;

    if (fileChange.isNewFile) {
      // Create new file
      const content = fileChange.textChanges
        .map((change) => change.newText)
        .join("");
      fs.writeFileSync(filePath, content, "utf-8");
      created.push(filePath);
    } else if (fs.existsSync(filePath)) {
      // Apply changes to existing file
      let content = fs.readFileSync(filePath, "utf-8");

      // Sort changes in reverse order to apply from end to start
      const sortedChanges = [...fileChange.textChanges].sort(
        (a, b) => b.span.start - a.span.start
      );

      for (const change of sortedChanges) {
        content =
          content.substring(0, change.span.start) +
          change.newText +
          content.substring(change.span.start + change.span.length);
      }

      fs.writeFileSync(filePath, content, "utf-8");
      changedFiles.push(filePath);

      // Update in-memory document
      documentContents.set(filePath, content);
      documentVersions.set(filePath, (documentVersions.get(filePath) || 0) + 1);
    }
  }

  return { changedFiles, created, deleted };
}
