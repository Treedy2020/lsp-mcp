/**
 * TypeScript Language Service wrapper.
 * Uses the official TypeScript compiler API for code intelligence.
 */

import ts from "typescript";
import * as path from "path";
import * as fs from "fs";

// Cache for language services per project
const serviceCache = new Map<string, ts.LanguageService>();
const documentVersions = new Map<string, number>();
const documentContents = new Map<string, string>();
// Track files that have been accessed (per project)
const accessedFilesPerProject = new Map<string, Set<string>>();

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
 * Get or create a language service for a project.
 */
export function getLanguageService(projectRoot: string): ts.LanguageService {
  if (serviceCache.has(projectRoot)) {
    return serviceCache.get(projectRoot)!;
  }

  // Read tsconfig.json if it exists
  const configPath = path.join(projectRoot, "tsconfig.json");
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
  };

  let rootFiles: string[] = [];

  if (fs.existsSync(configPath)) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        projectRoot
      );
      compilerOptions = parsed.options;
      rootFiles = parsed.fileNames;
    }
  }

  // Create the language service host
  const host: ts.LanguageServiceHost = {
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
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  serviceCache.set(projectRoot, service);
  return service;
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
function getServiceForFile(filePath: string): { service: ts.LanguageService; absPath: string; projectRoot: string } {
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
): ts.QuickInfo | undefined {
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
): readonly ts.DefinitionInfo[] | undefined {
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
): ts.ReferenceEntry[] | undefined {
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
): ts.CompletionInfo | undefined {
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
): ts.SignatureHelpItems | undefined {
  const { service, absPath } = getServiceForFile(filePath);
  const content = getFileContent(absPath);
  const offset = positionToOffset(content, line, column);
  return service.getSignatureHelpItems(absPath, offset, undefined);
}

/**
 * Get document symbols.
 */
export function getDocumentSymbols(filePath: string): ts.NavigationTree {
  const { service, absPath } = getServiceForFile(filePath);
  return service.getNavigationTree(absPath);
}

/**
 * Get diagnostics.
 */
export function getDiagnostics(filePath: string): ts.Diagnostic[] {
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
): readonly ts.RenameLocation[] | undefined {
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
export function formatDiagnostic(diag: ts.Diagnostic): {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  code: number;
} {
  const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
  const severity =
    diag.category === ts.DiagnosticCategory.Error
      ? "error"
      : diag.category === ts.DiagnosticCategory.Warning
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
  parts: ts.SymbolDisplayPart[] | undefined
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
): ts.ApplicableRefactorInfo[] {
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
): ts.RefactorEditInfo | undefined {
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
  if (info.kind !== ts.ScriptElementKind.functionElement &&
      info.kind !== ts.ScriptElementKind.memberFunctionElement &&
      info.kind !== ts.ScriptElementKind.constructorImplementationElement &&
      info.kind !== ts.ScriptElementKind.callSignatureElement) {
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
  changes: ts.FileTextChanges[]
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
