/**
 * Unified LSP MCP Server
 *
 * Aggregates multiple language-specific LSP backends into a single MCP server.
 * Supports Python (via python-lsp-mcp or pyright-mcp) and TypeScript backends.
 *
 * Tools are dynamically loaded from backends on-demand:
 * - Use list_backends to see available backends
 * - Use start_backend to install and start a backend
 * - Once started, tools are available as python_hover, typescript_definition, etc.
 *
 * Backends are lazy-loaded - they're only installed and started when you call start_backend.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, spawn, spawnSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, inferLanguageFromPath, type PythonProvider, type Language } from "./config.js";
import { BackendManager } from "./backend-manager.js";
import {
  status as statusTool,
  checkVersions as checkVersionsTool,
  switchPythonBackend,
  switchPythonBackendSchema,
  listBackends as listBackendsTool,
  startBackend as startBackendTool,
  startBackendSchema,
  updateBackend as updateBackendTool,
  updateBackendSchema,
  getBackendPackages,
} from "./tools/meta.js";
import { registerPrompts } from "./prompts.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

// Load configuration
const config = loadConfig();

// Create backend manager
const backendManager = new BackendManager(config);

// Track which backends have been started (to avoid duplicate tool registration)
const startedBackends = new Set<Language>();
// Track registered tool names to avoid duplicate registration
const registeredTools = new Set<string>();
// Global active workspace path
let activeWorkspacePath: string | null = null;
const activeWorkspaceByLanguage = new Map<Language, string>();
// Cursor storage for paged high-volume responses
const cursorStore = new Map<string, { tool: string; items: any[]; createdAt: number; expiresAt: number; summary?: any; count?: number }>();
const CURSOR_TTL_MS = 10 * 60 * 1000;
const CURSOR_MAX_ENTRIES = 100;
const CURSOR_SECRET = randomBytes(16).toString("hex");
let vueBundledDepsMissingCache: boolean | null = null;
const VUE_STRICT_SEMANTIC = (process.env.LSP_MCP_VUE_STRICT_SEMANTIC ?? "true").toLowerCase() !== "false";
const VUE_FORCE_MISSING_SEMANTIC_DEPS = (process.env.LSP_MCP_VUE_FORCE_MISSING_SEMANTIC_DEPS ?? "false").toLowerCase() === "true";
const SINGLETON_BACKEND_ENABLED = (process.env.LSP_MCP_SINGLETON_BACKEND ?? "true").toLowerCase() !== "false";
const SINGLETON_BACKEND_PROXY_ENABLED = (process.env.LSP_MCP_SINGLETON_BACKEND_PROXY ?? "true").toLowerCase() !== "false";
const backendSingletonLocks = new Map<string, string>();
const BACKEND_LOCK_DIR = process.env.LSP_MCP_BACKEND_LOCK_DIR || path.join("/tmp", "lsp-mcp-locks");
let singletonRpcServer: net.Server | null = null;
let singletonRpcEndpoint: { host: string; port: number } | null = null;
let singletonRpcStarting = false;
const REGISTRY_LOOKUP_TTL_MS = Number.parseInt(process.env.LSP_MCP_REGISTRY_LOOKUP_TTL_MS || "300000", 10);
type RegistryLookupResult = { latest_version: string | null; source: "npm" | "pypi" | "unknown"; error?: string };
const registryLatestCache = new Map<string, { value: RegistryLookupResult; expiresAt: number }>();
const registryLatestInflight = new Map<string, Promise<RegistryLookupResult>>();

function resolveBackendRuntimeMode(): "registry" | "bundled" | "auto" {
  const requireBundled = (process.env.LSP_MCP_REQUIRE_BUNDLED_BACKENDS ?? "false").toLowerCase() === "true";
  if (requireBundled) return "bundled";
  const mode = (process.env.LSP_MCP_BACKEND_RUNTIME_MODE || "registry").toLowerCase();
  if (mode === "registry" || mode === "bundled" || mode === "auto") return mode;
  return "registry";
}

async function runCommandCapture(command: string, args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: -1, stdout, stderr: `${stderr}\ncommand timeout`.trim() });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

function getWorkspaceForLanguage(language: Language): string | null {
  return activeWorkspaceByLanguage.get(language) || null;
}

function getWorkspaceOverride(language: Language): string | null {
  return activeWorkspaceByLanguage.get(language) || null;
}

const SEMANTIC_TOOL_NAMES = new Set([
  "hover",
  "definition",
  "implementation",
  "type_definition",
  "call_hierarchy",
  "type_hierarchy",
  "document_highlight",
  "code_lens",
  "selection_range",
  "folding_range",
  "document_link",
  "linked_editing_range",
  "semantic_tokens",
  "moniker",
  "inlay_hint_resolve",
  "references",
  "symbols",
  "completions",
  "diagnostics",
  "rename",
  "prepare_rename",
  "signature_help",
  "read_file_with_hints",
  "semantic_navigate",
  "peek_definition",
  "code_action",
  "update_document",
  "inlay_hints",
  "move",
  "change_signature",
  "function_signature",
]);

function isSemanticTool(toolName: string): boolean {
  return SEMANTIC_TOOL_NAMES.has(toolName);
}

function semanticWorkspaceRequiredResponse(language: Language, toolName: string) {
  const setupCommand = `switch_workspace_for_language(language='${language}', path='/abs/project/root')`;
  const recoveryPlan = [{
    step: 1,
    action: "set_language_workspace",
    command: setupCommand,
    reason: "Semantic tools require an explicit per-language workspace mapping.",
  }];
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "LANGUAGE_WORKSPACE_REQUIRED",
        error_code: "LANGUAGE_WORKSPACE_REQUIRED",
        message: `Tool '${toolName}' requires an explicit workspace for '${language}'.`,
        language,
        resolved_language: language,
        tool: toolName,
        strict_mode: true,
        missing_workspace_for_language: language,
        required_workspace_scope: "language",
        next_step: `Call ${setupCommand} before using semantic tools.`,
        install_commands: [setupCommand],
        recovery_plan: recoveryPlan,
        missing_packages: [],
        resolved_workspace: null,
        backend_instance_id: null,
        result_size: 0,
        cursor_available: false,
        truncated: false,
        latency_ms: null,
      }),
    }],
  };
}

function buildRecoveryPlan(installCommands: string[], nextStep: string): Array<{ step: number; action: string; command: string; reason: string }> {
  const normalized = Array.from(new Set(
    installCommands
      .map((command) => String(command || "").trim())
      .filter((command) => command.length > 0)
  ));
  if (normalized.length === 0 && nextStep.trim().length > 0) {
    normalized.push(nextStep.trim());
  }
  return normalized.map((command, idx) => ({
    step: idx + 1,
    action: idx === 0 ? "run_next_step" : "retry_with_followup",
    command,
    reason: "Follow this command sequence to recover from strict semantic errors.",
  }));
}

function inferResponseResultSize(payload: Record<string, unknown>): number {
  if (typeof payload.count === "number" && Number.isFinite(payload.count)) return payload.count;
  const arrayKeys = ["matches", "references", "diagnostics", "lines", "symbols", "hints"];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  if (typeof payload.result === "string") return payload.result.length;
  return 0;
}

function withStandardCostFields(payload: Record<string, unknown>): Record<string, unknown> {
  const page = payload.page && typeof payload.page === "object" ? payload.page as Record<string, unknown> : null;
  const preview = payload.preview && typeof payload.preview === "object" ? payload.preview as Record<string, unknown> : null;
  const hasCursor = (
    (payload.next && typeof payload.next === "object" && !!(payload.next as Record<string, any>)?.arguments?.cursor) ||
    (page && page.has_more === true)
  );
  const truncated = (
    (preview && preview.truncated === true) ||
    (page && page.has_more === true)
  );
  return {
    ...payload,
    result_size: typeof payload.result_size === "number" ? payload.result_size : inferResponseResultSize(payload),
    cursor_available: typeof payload.cursor_available === "boolean" ? payload.cursor_available : !!hasCursor,
    truncated: typeof payload.truncated === "boolean" ? payload.truncated : !!truncated,
    latency_ms: typeof payload.latency_ms === "number" ? payload.latency_ms : null,
  };
}

function normalizeSemanticErrorPayload(
  payload: Record<string, unknown>,
  toolName: string,
  resolvedLanguage: Language | "multi" | null | undefined,
  resolvedWorkspace: string | null
): Record<string, unknown> {
  const rawError = payload.error;
  const hasError = typeof rawError === "string" && rawError.length > 0;
  if (!hasError) return payload;

  const lower = String(rawError).toLowerCase();
  const normalizedCode =
    typeof payload.error_code === "string" && payload.error_code.length > 0
      ? payload.error_code
      : lower.includes("workspace")
        ? "LANGUAGE_WORKSPACE_REQUIRED"
        : lower.includes("dependency")
          ? "SEMANTIC_DEPENDENCIES_MISSING"
          : lower.includes("timeout")
            ? "SEMANTIC_BACKEND_TIMEOUT"
            : "SEMANTIC_TOOL_ERROR";

  const nextStep =
    typeof payload.next_step === "string" && payload.next_step.length > 0
      ? payload.next_step
      : resolvedLanguage && resolvedLanguage !== "multi"
        ? `Call switch_workspace_for_language(language='${resolvedLanguage}', path='/abs/project/root') then retry ${toolName}.`
        : `Retry ${toolName} after setting per-language workspace with switch_workspace_for_language(...).`;

  const installCommands = Array.isArray(payload.install_commands)
    ? payload.install_commands
    : [nextStep];

  const missingPackages = Array.isArray(payload.missing_packages)
    ? payload.missing_packages
    : [];
  const recoveryPlan = Array.isArray(payload.recovery_plan)
    ? payload.recovery_plan
    : buildRecoveryPlan(installCommands.map((cmd) => String(cmd)), nextStep);

  return withStandardCostFields({
    ...payload,
    error_code: normalizedCode,
    strict_mode: payload.strict_mode ?? true,
    next_step: nextStep,
    install_commands: installCommands,
    recovery_plan: recoveryPlan,
    missing_packages: missingPackages,
    tool: payload.tool ?? toolName,
    resolved_language: payload.resolved_language ?? resolvedLanguage ?? null,
    resolved_workspace: payload.resolved_workspace ?? resolvedWorkspace ?? null,
  });
}

function withSemanticContext(
  response: { content: Array<{ type: "text"; text: string }> },
  toolName: string,
  resolvedWorkspace: string | null,
  backendInstanceId: string | null,
  resolvedLanguage?: Language | "multi" | null
): { content: Array<{ type: "text"; text: string }> } {
  if (!isSemanticTool(toolName)) return response;
  const languageFromBackendId = (() => {
    if (!backendInstanceId) return null;
    const m = /^proxy:(python|typescript|vue)@/.exec(backendInstanceId);
    return m?.[1] ?? null;
  })();
  const effectiveLanguage = resolvedLanguage ?? languageFromBackendId;
  const first = response.content?.[0];
  if (!first || first.type !== "text") return response;
  try {
    const parsed = JSON.parse(first.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result: parsed,
            resolved_language: effectiveLanguage,
            resolved_workspace: resolvedWorkspace,
            backend_instance_id: backendInstanceId,
          }),
        }],
      };
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const parsedResolvedLanguage =
      (typeof parsedRecord.resolved_language === "string" ? parsedRecord.resolved_language : null) ||
      (typeof parsedRecord.language === "string" ? parsedRecord.language : null) ||
      effectiveLanguage;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...withStandardCostFields(normalizeSemanticErrorPayload(
            parsedRecord,
            toolName,
            parsedResolvedLanguage as Language | "multi" | null,
            resolvedWorkspace
          )),
          resolved_language: parsed.resolved_language ?? parsed.language ?? effectiveLanguage,
          resolved_workspace: resolvedWorkspace,
          backend_instance_id: backendInstanceId,
        }),
      }],
    };
  } catch {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          result: first.text,
          resolved_language: effectiveLanguage,
          resolved_workspace: resolvedWorkspace,
          backend_instance_id: backendInstanceId,
          result_size: typeof first.text === "string" ? first.text.length : 0,
          cursor_available: false,
          truncated: false,
          latency_ms: null,
        }),
      }],
    };
  }
}

type WorkspaceCandidate = {
  dir: string;
  pythonScore: number;
  typescriptScore: number;
  vueScore: number;
  hasPyproject: boolean;
  hasRequirements: boolean;
  hasPackageJson: boolean;
  hasTsconfig: boolean;
  hasViteConfig: boolean;
  hasVueDependency: boolean;
};

type ProbeMetadata = {
  expected_latency_ms: { p50: number; p95: number };
  failure_signatures: string[];
};

const LLM_FEATURE_PROBE_METADATA = {
  hover: {
    expected_latency_ms: { p50: 120, p95: 1200 },
    failure_signatures: ["LANGUAGE_WORKSPACE_REQUIRED", "VUE_SEMANTIC_DEPS_MISSING", "No information available at this position"],
  },
  definition: {
    expected_latency_ms: { p50: 180, p95: 1600 },
    failure_signatures: ["LANGUAGE_WORKSPACE_REQUIRED", "VUE_SEMANTIC_DEPS_MISSING", "No definition found"],
  },
  references: {
    expected_latency_ms: { p50: 260, p95: 2200 },
    failure_signatures: ["LANGUAGE_WORKSPACE_REQUIRED", "VUE_SEMANTIC_DEPS_MISSING", "count: 0"],
  },
  read_file_with_hints: {
    expected_latency_ms: { p50: 300, p95: 2600 },
    failure_signatures: ["LANGUAGE_WORKSPACE_REQUIRED", "No inlay hint support available", "Failed to read file with hints"],
  },
  semantic_tokens: {
    expected_latency_ms: { p50: 220, p95: 1800 },
    failure_signatures: ["NOT_IMPLEMENTED", "Method not found", "VUE_SEMANTIC_DEPS_MISSING"],
  },
  moniker: {
    expected_latency_ms: { p50: 200, p95: 1800 },
    failure_signatures: ["NOT_IMPLEMENTED", "No symbol moniker available", "No definition found"],
  },
  linked_editing_range: {
    expected_latency_ms: { p50: 220, p95: 2000 },
    failure_signatures: ["NOT_IMPLEMENTED", "count: 0", "Cannot rename symbol at this position"],
  },
  inlay_hint_resolve: {
    expected_latency_ms: { p50: 260, p95: 2000 },
    failure_signatures: ["NOT_IMPLEMENTED", "No inlay hint found", "No inlay hint support available"],
  },
  call_hierarchy: {
    expected_latency_ms: { p50: 280, p95: 2200 },
    failure_signatures: ["NOT_IMPLEMENTED", "No call hierarchy available", "LANGUAGE_WORKSPACE_REQUIRED"],
  },
} satisfies Record<string, ProbeMetadata>;

const LLM_FEATURE_TARGETS = [
  "semantic_tokens",
  "linked_editing_range",
  "moniker",
  "inlay_hint_resolve",
  "read_file_with_hints",
  "call_hierarchy",
] as const;

function fileExistsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function hasVueDependencyInPackageJson(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!fileExistsSafe(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    } as Record<string, string>;
    return "vue" in deps || "@vue/runtime-core" in deps;
  } catch {
    return false;
  }
}

function evaluateWorkspaceCandidate(dir: string): WorkspaceCandidate {
  const hasPyproject = fileExistsSafe(path.join(dir, "pyproject.toml"));
  const hasRequirements = fileExistsSafe(path.join(dir, "requirements.txt"));
  const hasPackageJson = fileExistsSafe(path.join(dir, "package.json"));
  const hasTsconfig = fileExistsSafe(path.join(dir, "tsconfig.json"));
  const hasViteConfig =
    fileExistsSafe(path.join(dir, "vite.config.ts")) ||
    fileExistsSafe(path.join(dir, "vite.config.js")) ||
    fileExistsSafe(path.join(dir, "vite.config.mjs")) ||
    fileExistsSafe(path.join(dir, "vite.config.cjs"));
  const hasVueDependency = hasVueDependencyInPackageJson(dir);

  const pythonScore = (hasPyproject ? 100 : 0) + (hasRequirements ? 40 : 0);
  const vueScore = (hasViteConfig ? 70 : 0) + (hasVueDependency ? 60 : 0) + (hasPackageJson ? 10 : 0);
  const typescriptScore =
    (hasTsconfig ? 80 : 0) +
    (hasPackageJson ? 30 : 0) +
    ((hasTsconfig || hasPackageJson) && !hasVueDependency ? 20 : 0);

  return {
    dir,
    pythonScore,
    typescriptScore,
    vueScore,
    hasPyproject,
    hasRequirements,
    hasPackageJson,
    hasTsconfig,
    hasViteConfig,
    hasVueDependency,
  };
}

function discoverWorkspaceCandidates(rootPath: string, maxDepth = 2): WorkspaceCandidate[] {
  const candidates: WorkspaceCandidate[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const seen = new Set<string>();
  const IGNORED = new Set([".git", "node_modules", "dist", "build", ".venv", ".idea", ".vscode", ".next", ".nuxt"]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.dir)) continue;
    seen.add(current.dir);

    const candidate = evaluateWorkspaceCandidate(current.dir);
    if (candidate.pythonScore > 0 || candidate.typescriptScore > 0 || candidate.vueScore > 0) {
      candidates.push(candidate);
    }

    if (current.depth >= maxDepth) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (IGNORED.has(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return candidates;
}

function pickLanguageWorkspace(
  language: Language,
  candidates: WorkspaceCandidate[],
  discoveryRoot?: string
): WorkspaceCandidate | null {
  const pathPenalty = (dir: string): number => {
    const lowered = dir.toLowerCase();
    const segments = lowered.split(path.sep).filter(Boolean);
    if (segments.some((seg) => seg === "cypress" || seg === "e2e" || seg === "__tests__")) {
      return -500;
    }
    if (segments.some((seg) => seg === "test" || seg === "tests" || seg === "spec" || seg === "fixtures")) {
      return -180;
    }
    return 0;
  };
  const pathDepthScore = (dir: string): number => {
    const depth = dir.split(path.sep).filter(Boolean).length;
    return Math.max(0, 30 - depth);
  };
  const relativeDepthScore = (dir: string): number => {
    if (!discoveryRoot) return 0;
    const rel = path.relative(discoveryRoot, dir);
    if (!rel || rel === ".") return 80;
    if (rel.startsWith("..")) return 0;
    const segments = rel.split(path.sep).filter(Boolean);
    return Math.max(0, 70 - segments.length * 25);
  };
  const typescriptPreferenceScore = (candidate: WorkspaceCandidate): number => {
    let score = candidate.typescriptScore;
    if (candidate.hasPackageJson) score += 60;
    if (candidate.hasTsconfig) score += 25;
    if (candidate.hasViteConfig || candidate.hasVueDependency) score -= 30;
    score += relativeDepthScore(candidate.dir);
    score += pathDepthScore(candidate.dir);
    score += pathPenalty(candidate.dir);
    return score;
  };
  const sorted = [...candidates].sort((a, b) => {
    if (language === "python") return b.pythonScore - a.pythonScore;
    if (language === "vue") return b.vueScore - a.vueScore;
    return typescriptPreferenceScore(b) - typescriptPreferenceScore(a);
  });

  if (language === "typescript") {
    if (discoveryRoot) {
      const directChildren = sorted.filter((c) =>
        c.typescriptScore > 0 &&
        !c.hasVueDependency &&
        c.hasPackageJson &&
        path.dirname(c.dir) === discoveryRoot
      );
      if (directChildren.length > 0) return directChildren[0];
    }
    // Prefer TS-only project over Vue app when both are present.
    const tsOnly = sorted.find((c) => c.typescriptScore > 0 && !c.hasVueDependency);
    if (tsOnly) return tsOnly;
  }

  return (
    sorted.find((c) => {
      if (language === "python") return c.pythonScore > 0;
      if (language === "vue") return c.vueScore > 0;
      return c.typescriptScore > 0;
    }) || null
  );
}

function inferWorkspaceRootFromFile(filePath: string, language: Language): string {
  let current = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);
  const markersByLanguage: Record<string, string[]> = {
    python: ["pyproject.toml", "requirements.txt", "setup.py"],
    typescript: ["package.json", "tsconfig.json"],
    vue: ["package.json", "vite.config.ts", "vite.config.js", "vue.config.js"],
  };
  const markers = markersByLanguage[language] || [];
  for (let i = 0; i < 6; i++) {
    if (markers.some((marker) => fs.existsSync(path.join(current, marker)))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? filePath
    : path.dirname(filePath);
}

function isCodeSampleFile(filePath: string, language: Language): boolean {
  const lower = filePath.toLowerCase();
  if (lower.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (lower.includes(`${path.sep}.git${path.sep}`)) return false;
  if (lower.includes(`${path.sep}dist${path.sep}`)) return false;
  if (lower.includes(`${path.sep}build${path.sep}`)) return false;
  if (lower.includes(`${path.sep}.next${path.sep}`)) return false;
  if (lower.includes(`${path.sep}.nuxt${path.sep}`)) return false;
  if (lower.includes(`${path.sep}.venv${path.sep}`)) return false;
  if (lower.includes(`${path.sep}__pycache__${path.sep}`)) return false;
  if (language === "python") return lower.endsWith(".py");
  if (language === "vue") return lower.endsWith(".vue");
  if (language === "typescript") return (lower.endsWith(".ts") || lower.endsWith(".tsx")) && !lower.endsWith(".d.ts");
  return false;
}

function findSampleFileForLanguage(workspace: string | null, language: Language): string | null {
  if (!workspace || !fileExistsSafe(workspace)) return null;
  let root = workspace;
  try {
    const stats = fs.statSync(root);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }

  const preferredRoots = [
    path.join(root, "src"),
    path.join(root, "app"),
    path.join(root, "packages"),
    root,
  ];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const dir of preferredRoots) {
    if (fileExistsSafe(dir) && !seen.has(dir)) {
      queue.push(dir);
      seen.add(dir);
    }
  }

  let scanned = 0;
  const maxScanned = 1200;
  const ignoredDirs = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".venv", "__pycache__"]);

  while (queue.length > 0 && scanned < maxScanned) {
    const current = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      scanned++;
      if (scanned > maxScanned) break;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (ignoredDirs.has(entry.name)) continue;
        if (!seen.has(abs)) {
          seen.add(abs);
          queue.push(abs);
        }
        continue;
      }
      if (entry.isFile() && isCodeSampleFile(abs, language)) {
        return abs;
      }
    }
  }
  return null;
}

// Create MCP server
const server = new McpServer({
  name: "lsp-mcp",
  version: packageJson.version,
});

// ============================================================================ 
// Prompts (Skills)
// ============================================================================ 

registerPrompts(server);

// ============================================================================ 
// Helper Functions for New Tools
// ============================================================================ 

/**
 * Generate a visual tree structure of the project, focusing on code files.
 */
function getProjectStructure(
  dirPath: string,
  maxDepth = 3,
  maxEntries = 300
): { tree: string; shownEntries: number; truncated: boolean } {
  const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "__pycache__", ".venv", ".idea", ".vscode", ".next", ".nuxt"]);
  const KEY_FILES = new Set(["package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "README.md", "Dockerfile", "docker-compose.yml", "cargo.toml", "go.mod", "gemfile"]);
  let shownEntries = 0;
  let truncated = false;

  const walk = (currentPath: string, depth: number): string => {
    if (depth > maxDepth || truncated) return "";

    let output = "";
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return "";
    }

    // Sort: Directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // Skip hidden files by default
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (shownEntries >= maxEntries) {
        truncated = true;
        break;
      }

      shownEntries++;
      const isDir = entry.isDirectory();
      const indent = "  ".repeat(depth);
      const marker = isDir ? "📁 " : "📄 ";
      const isKeyFile = KEY_FILES.has(entry.name.toLowerCase());
      const extra = isKeyFile ? " (config)" : "";

      output += `${indent}${marker}${entry.name}${extra}\n`;

      if (isDir) {
        output += walk(path.join(currentPath, entry.name), depth + 1);
      }
    }

    return output;
  };

  return {
    tree: walk(dirPath, 0),
    shownEntries,
    truncated,
  };
}

/**
 * Get list of files changed in git (working tree + staged).
 */
function getGitChangedFiles(cwd: string): string[] {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const files = new Set<string>();
    
    // Working tree changes
    try {
        const stdout = execSync("git diff --name-only", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] });
        stdout.split('\n').forEach(f => { if (f.trim()) files.add(path.resolve(gitRoot, f.trim())); });
    } catch (e) { /* ignore */ }

    // Staged changes
    try {
        const stdout = execSync("git diff --staged --name-only", { cwd, encoding: "utf-8", stdio: ['ignore', 'pipe', 'ignore'] });
        stdout.split('\n').forEach(f => { if (f.trim()) files.add(path.resolve(gitRoot, f.trim())); });
    } catch (e) { /* ignore */ }
    
    return Array.from(files);
  } catch (error) {
    return [];
  }
}

/**
 * Validate and fuzzy-fix line/column positions.
 * Reads the file to ensure coordinates are within bounds.
 */
function validateAndFixPosition(filePath: string, line: number, column: number): { line: number, column: number, warning?: string } {
    try {
        if (!fs.existsSync(filePath)) return { line, column };
        
        // Don't read huge files for this check
        const stats = fs.statSync(filePath);
        if (stats.size > 1024 * 1024) return { line, column }; // Skip for > 1MB

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        // 1-based line correction
        let newLine = line;
        let warning = "";
        
        if (newLine > lines.length) {
            newLine = lines.length;
            warning = `Line ${line} out of bounds (max ${lines.length}). Clamped to ${newLine}.`;
        }
        if (newLine < 1) {
            newLine = 1;
            warning = `Line ${line} must be positive. Clamped to 1.`;
        }
        
        // 1-based column correction
        // Get line content (0-based index)
        const lineContent = lines[newLine - 1] || "";
        let newColumn = column;
        
        // Allow column to be line length + 1 (end of line)
        const maxCol = lineContent.length + 1;
        
        if (newColumn > maxCol) {
            newColumn = maxCol;
            const w = `Column ${column} out of bounds (max ${maxCol}). Clamped to ${newColumn}.`;
            warning = warning ? `${warning} ${w}` : w;
        }
        if (newColumn < 1) {
            newColumn = 1;
            const w = `Column ${column} must be positive. Clamped to 1.`;
            warning = warning ? `${warning} ${w}` : w;
        }
        
        return { line: newLine, column: newColumn, warning: warning || undefined };
    } catch (e) {
        // Fallback if anything fails
        return { line, column };
    }
}

// ============================================================================ 
// Dynamic Tool Registration Helpers
// ============================================================================ 

/**
 * Convert a backend tool schema to Zod schema for MCP registration.
 * The backend returns JSON Schema format, we need to convert to Zod.
 */
function jsonSchemaToZod(schema: any): Record<string, z.ZodTypeAny> {
  const result: Record<string, z.ZodTypeAny> = {};

  if (!schema || !schema.properties) {
    return result;
  }

  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    let zodType: z.ZodTypeAny = schemaToZod(prop);

    // Add description
    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    // Add default
    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default);
    }

    // Make optional if not required
    if (!required.has(key)) {
      zodType = zodType.optional();
    }

    result[key] = zodType;
  }

  return result;
}

function schemaToZod(schema: any): z.ZodTypeAny {
  if (!schema) return z.any();

  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf) as any[];
    const mapped = variants.map((variant) => schemaToZod(variant));
    if (mapped.length === 1) return mapped[0];
    if (mapped.length > 1) return z.union(mapped as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return z.any();
  }

  if (schema.allOf) {
    const variants = schema.allOf as any[];
    if (variants.length === 0) return z.any();
    return variants.map((variant) => schemaToZod(variant)).reduce((acc, next) => z.intersection(acc, next));
  }

  if (schema.enum && schema.type === "string") {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  switch (schema.type) {
    case "string": {
      let zodType: z.ZodTypeAny = z.string();
      if (schema.minLength !== undefined) zodType = (zodType as z.ZodString).min(schema.minLength);
      if (schema.maxLength !== undefined) zodType = (zodType as z.ZodString).max(schema.maxLength);
      if (schema.pattern) {
        try {
          zodType = (zodType as z.ZodString).regex(new RegExp(schema.pattern));
        } catch {
          // Ignore invalid regex patterns.
        }
      }
      return zodType;
    }
    case "number":
    case "integer": {
      let zodType: z.ZodTypeAny = z.number();
      if (schema.type === "integer") {
        zodType = (zodType as z.ZodNumber).int();
      }
      if (schema.exclusiveMinimum !== undefined) {
        zodType = (zodType as z.ZodNumber).gt(schema.exclusiveMinimum);
      }
      if (schema.minimum !== undefined) {
        zodType = (zodType as z.ZodNumber).gte(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        zodType = (zodType as z.ZodNumber).lte(schema.maximum);
      }
      return zodType;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schemaToZod(schema.items ?? {}));
    case "object": {
      if (schema.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required = new Set(schema.required || []);
        for (const [key, prop] of Object.entries<any>(schema.properties)) {
          let propSchema = schemaToZod(prop);
          if (prop.description) {
            propSchema = propSchema.describe(prop.description);
          }
          if (prop.default !== undefined) {
            propSchema = propSchema.default(prop.default);
          }
          if (!required.has(key)) {
            propSchema = propSchema.optional();
          }
          shape[key] = propSchema;
        }
        return z.object(shape).passthrough();
      }
      return z.record(z.any());
    }
    default:
      return z.any();
  }
}

/**
 * Start a backend and register its tools.
 * Returns the number of tools registered.
 */
async function startAndRegisterBackend(language: Language): Promise<number> {
  // Check if already started
  if (startedBackends.has(language)) {
    const status = backendManager.getStatus()[language];
    console.error(`[lsp-mcp] ${language} backend already started (${status?.tools} tools)`)
    return status?.tools || 0;
  }

  console.error(`[lsp-mcp] Starting ${language} backend...`);

  try {
    // Just start the backend, tools are already registered via unified routing
    await backendManager.getBackend(language);
    startedBackends.add(language);
    console.error(`[lsp-mcp] ${language} backend started`);
    return 0; // We don't register new tools dynamically anymore
  } catch (error) {
    console.error(`[lsp-mcp] Failed to start ${language} backend:`, error);
    throw error;
  }
}

/**
 * Update a backend to the latest version.
 * Restarts the backend and re-registers tools if already started.
 */
async function updateAndRestartBackend(language: Language): Promise<{ oldVersion: string | null; newVersion: string | null }> {
  console.error(`[lsp-mcp] Updating ${language} backend...`);

  // Restart the backend to get the latest version
  const result = await backendManager.restartBackend(language);
  startedBackends.add(language);
  
  return result;
}

// ============================================================================ 
// Meta Tools
// ============================================================================ 

server.registerTool(
  "status",
  { description: "Get status of all LSP backends and server configuration" },
  async () => statusTool(
    backendManager,
    config,
    {
      global: activeWorkspacePath,
      perLanguage: {
        python: getWorkspaceOverride("python"),
        typescript: getWorkspaceOverride("typescript"),
        vue: getWorkspaceOverride("vue"),
      },
      resolvedPerLanguage: {
        python: getWorkspaceForLanguage("python"),
        typescript: getWorkspaceForLanguage("typescript"),
        vue: getWorkspaceForLanguage("vue"),
      },
    }
  )
);

server.registerTool(
  "check_versions",
  { description: "Check versions of all backends and server. Shows installed versions and how to check for updates." },
  async () => checkVersionsTool(backendManager, config)
);

server.registerTool(
  "reload_config",
  { description: "Reload configuration from environment variables. Useful for changing settings without restarting the server." },
  async () => {
    const newConfig = loadConfig();
    backendManager.updateConfig(newConfig);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, message: "Configuration reloaded", config: newConfig }) }],
    };
  }
);

server.registerTool(
  "semantic_session_start",
  {
    description: "Bootstrap semantic LSP workflow for one language: resolve language/workspace, validate dependencies, and return next-step commands.",
    inputSchema: {
      language: z.enum(["python", "typescript", "vue"]).optional(),
      workspace: z.string().optional(),
      file: z.string().optional(),
      start_backend: z.boolean().default(true).optional(),
    },
  },
  async ({ language, workspace, file, start_backend }) => {
    const requestedPath = file || workspace || null;
    let resolvedLanguage: Language | null = language || null;
    if (!resolvedLanguage && requestedPath) {
      const abs = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(requestedPath);
      resolvedLanguage = inferLanguageFromPath(abs, config);
    }

    if (!resolvedLanguage) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "SEMANTIC_SESSION_LANGUAGE_REQUIRED",
            error_code: "SEMANTIC_SESSION_LANGUAGE_REQUIRED",
            message: "Unable to infer language. Provide language or a file/workspace path.",
            next_step: "Call semantic_session_start(language='typescript'|'python'|'vue', workspace='/abs/project/root').",
            install_commands: ["semantic_session_start(language='typescript', workspace='/abs/project/root')"],
            missing_packages: [],
            strict_mode: true,
          }),
        }],
      };
    }

    if (!config.languages[resolvedLanguage]?.enabled) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "LANGUAGE_DISABLED",
            error_code: "LANGUAGE_DISABLED",
            language: resolvedLanguage,
            message: `Language '${resolvedLanguage}' is disabled in current config.`,
            next_step: `Set LSP_MCP_${resolvedLanguage.toUpperCase()}_ENABLED=true and restart server.`,
            install_commands: [],
            missing_packages: [],
            strict_mode: true,
          }),
        }],
      };
    }

    let resolvedWorkspace = workspace || getWorkspaceForLanguage(resolvedLanguage) || activeWorkspacePath || null;
    if (!resolvedWorkspace && file) {
      const absFile = path.isAbsolute(file) ? file : path.resolve(file);
      resolvedWorkspace = inferWorkspaceRootFromFile(absFile, resolvedLanguage);
    }
    if (resolvedWorkspace && !path.isAbsolute(resolvedWorkspace)) {
      resolvedWorkspace = path.resolve(resolvedWorkspace);
    }

    const commands: string[] = [];
    if (resolvedWorkspace) {
      activeWorkspaceByLanguage.set(resolvedLanguage, resolvedWorkspace);
      commands.push(`switch_workspace_for_language(language='${resolvedLanguage}', path='${resolvedWorkspace}')`);
      if (!activeWorkspacePath) {
        activeWorkspacePath = resolvedWorkspace;
        commands.unshift(`switch_workspace(path='${resolvedWorkspace}')`);
      }
    } else {
      commands.push(`switch_workspace_for_language(language='${resolvedLanguage}', path='/abs/project/root')`);
    }

    const missingPackages: string[] = [];
    const installCommands: string[] = [];
    let dependencyStatus: "ok" | "missing" = "ok";

    if (resolvedLanguage === "vue") {
      const vueRoot = resolvedWorkspace || "<your-vue-project-root>";
      const deps = resolvedWorkspace ? checkVueProjectDeps(resolvedWorkspace) : null;
      if (!deps || !deps.ok) {
        dependencyStatus = "missing";
        missingPackages.push(...(deps?.missing_packages || ["typescript", "@vue/language-server"]));
        installCommands.push(
          `cd ${vueRoot} && pnpm add -D typescript @vue/language-server`,
          `cd ${vueRoot} && npm install -D typescript @vue/language-server`,
          `cd ${vueRoot} && yarn add -D typescript @vue/language-server`,
          `cd ${vueRoot} && bun add -d typescript @vue/language-server`
        );
      }
    }

    if (resolvedLanguage === "python") {
      const uvCheck = spawnSync("uv", ["--version"], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
      if (uvCheck.status !== 0) {
        dependencyStatus = "missing";
        missingPackages.push("uv");
        installCommands.push("Install uv: https://docs.astral.sh/uv/getting-started/installation/");
      }
    }

    if (resolvedLanguage !== "python") {
      const nodeCheck = spawnSync("node", ["--version"], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
      const npxCheck = spawnSync("npx", ["--version"], { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
      if (nodeCheck.status !== 0 || npxCheck.status !== 0) {
        dependencyStatus = "missing";
        if (!missingPackages.includes("node")) missingPackages.push("node");
        if (!missingPackages.includes("npx")) missingPackages.push("npx");
        installCommands.push("Install Node.js (includes npx): https://nodejs.org/");
      }
    }

    const backendPackages = getBackendPackages(config);
    const backendPackage = backendPackages.find((pkg) => pkg.language === resolvedLanguage) || null;

    let backendStarted = false;
    let backendStartError: string | null = null;
    let availableTools: string[] | null = null;
    const shouldStartBackend = start_backend !== false;
    if (shouldStartBackend && resolvedWorkspace && dependencyStatus === "ok") {
      try {
        const lock = await ensureBackendSingleton(resolvedLanguage, resolvedWorkspace);
        if (lock.ok) {
          if (lock.proxyHost && lock.proxyPort) {
            backendStarted = true;
          } else {
            await backendManager.getBackend(resolvedLanguage);
            startedBackends.add(resolvedLanguage);
            await backendManager.callTool(resolvedLanguage, "switch_workspace", { path: resolvedWorkspace });
            backendStarted = true;
            availableTools = (await backendManager.getTools(resolvedLanguage)).map((t) => t.name);
          }
        } else {
          backendStartError = "Failed to acquire backend singleton lock.";
        }
      } catch (error) {
        backendStartError = String(error);
      }
    }

    const sampleFile =
      findSampleFileForLanguage(resolvedWorkspace, resolvedLanguage) ||
      (resolvedLanguage === "python"
        ? "/abs/path/to/module.py"
        : resolvedLanguage === "vue"
          ? "/abs/path/to/component.vue"
          : "/abs/path/to/file.ts");
    const sampleHover = `hover(file='${sampleFile}', line=1, column=1)`;
    commands.push(sampleHover);
    const isSupported = (name: string) => (availableTools ? availableTools.includes(name) : true);
    const probeMeta = LLM_FEATURE_PROBE_METADATA;
    const probeSteps = [
      {
        phase: "p0_bootstrap",
        feature: "hover",
        command: sampleHover,
        expected: "basic semantic pipeline alive",
        expected_latency_ms: probeMeta.hover.expected_latency_ms,
        failure_signatures: probeMeta.hover.failure_signatures,
      },
      {
        phase: "p0_bootstrap",
        feature: "definition",
        command: `definition(file='${sampleFile}', line=1, column=1)`,
        expected: "cross-file navigation ready",
        expected_latency_ms: probeMeta.definition.expected_latency_ms,
        failure_signatures: probeMeta.definition.failure_signatures,
      },
      {
        phase: "p1_context",
        feature: "references",
        command: `references(file='${sampleFile}', line=1, column=1)`,
        expected: "fan-out impact graph available",
        expected_latency_ms: probeMeta.references.expected_latency_ms,
        failure_signatures: probeMeta.references.failure_signatures,
      },
      {
        phase: "p1_context",
        feature: "read_file_with_hints",
        command: `read_file_with_hints(file='${sampleFile}', start_line=1, max_lines=120)`,
        expected: "token-level reading with hints",
        expected_latency_ms: probeMeta.read_file_with_hints.expected_latency_ms,
        failure_signatures: probeMeta.read_file_with_hints.failure_signatures,
      },
      {
        phase: "p2_advanced",
        feature: "semantic_tokens",
        command: `semantic_tokens(file='${sampleFile}')`,
        expected: "semantic structure tokens available",
        expected_latency_ms: probeMeta.semantic_tokens.expected_latency_ms,
        failure_signatures: probeMeta.semantic_tokens.failure_signatures,
      },
      {
        phase: "p2_advanced",
        feature: "moniker",
        command: `moniker(file='${sampleFile}', line=1, column=1)`,
        expected: "cross-package identity available",
        expected_latency_ms: probeMeta.moniker.expected_latency_ms,
        failure_signatures: probeMeta.moniker.failure_signatures,
      },
      {
        phase: "p2_advanced",
        feature: "linked_editing_range",
        command: `linked_editing_range(file='${sampleFile}', line=1, column=1)`,
        expected: "paired edits coordination ready",
        expected_latency_ms: probeMeta.linked_editing_range.expected_latency_ms,
        failure_signatures: probeMeta.linked_editing_range.failure_signatures,
      },
    ].map((step) =>
      isSupported(step.feature)
        ? { ...step, status: "supported" as const }
        : {
            ...step,
            status: "not_supported" as const,
            fallback_command: sampleHover,
          }
    );
    const success = !!resolvedWorkspace && dependencyStatus === "ok" && (!shouldStartBackend || backendStarted);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success,
          language: resolvedLanguage,
          resolved_language: resolvedLanguage,
          resolved_workspace: resolvedWorkspace,
          dependency_status: dependencyStatus,
          missing_packages: missingPackages,
          install_commands: installCommands,
          backend_package: backendPackage,
          backend_started: backendStarted,
          backend_start_error: backendStartError,
          strict_mode: true,
          commands,
          feature_probe_sequence: probeSteps,
          next_step: success ? commands[commands.length - 1] : (installCommands[0] || commands[0]),
        }),
      }],
    };
  }
);

server.registerTool(
  "semantic_navigate",
  {
    description: "Run an LLM-oriented semantic workflow in one call: optional search -> definition -> references -> read_file_with_hints.",
    inputSchema: {
      file: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      query: z.string().optional(),
      page_size: z.number().int().positive().max(200).default(20).optional(),
      hint_start_line: z.number().int().positive().default(1).optional(),
      hint_max_lines: z.number().int().positive().max(400).default(120).optional(),
      reference_preview: z.number().int().positive().max(200).default(20).optional(),
    },
  },
  async ({ file, line, column, query, page_size, hint_start_line, hint_max_lines, reference_preview }) => {
    const startedAt = Date.now();
    const absFile = path.isAbsolute(file)
      ? file
      : (activeWorkspacePath ? path.join(activeWorkspacePath, file) : path.resolve(file));
    const language = inferLanguageFromPath(absFile, config);
    if (!language) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "UNSUPPORTED_FILE_TYPE",
            error_code: "UNSUPPORTED_FILE_TYPE",
            message: `Cannot infer language for '${file}'.`,
            next_step: "Provide a file path with a supported extension.",
            recovery_plan: [{
              step: 1,
              action: "provide_supported_file",
              command: "semantic_navigate(file='/abs/path/to/file.ts|.py|.vue', line=1, column=1)",
              reason: "semantic_navigate requires a resolvable source file.",
            }],
            strict_mode: true,
          }),
        }],
      };
    }

    const workspace = getWorkspaceForLanguage(language);
    if (!workspace) {
      return semanticWorkspaceRequiredResponse(language, "semantic_navigate");
    }

    const singletonLock = await ensureBackendSingleton(language, workspace);
    if (!singletonLock.ok) {
      return withSemanticContext(singletonLock.response, "semantic_navigate", workspace, null, language);
    }
    const proxyHost = singletonLock.proxyHost;
    const proxyPort = singletonLock.proxyPort;
    const backendInstanceId =
      proxyHost && proxyPort
        ? `proxy:${language}@${proxyHost}:${proxyPort}`
        : (backendManager.getBackendIdentity(language)?.instanceId ?? null);
    const callBackendTool = (toolName: string, backendArgs: Record<string, unknown>) => {
      if (proxyHost && proxyPort) {
        return callRemoteBackendTool(proxyHost, proxyPort, language, toolName, backendArgs, workspace);
      }
      return backendManager.callTool(language, toolName, backendArgs);
    };

    if (!proxyHost && !proxyPort && !startedBackends.has(language)) {
      await backendManager.getBackend(language);
      startedBackends.add(language);
      await backendManager.callTool(language, "switch_workspace", { path: workspace });
    }

    const parseToolPayload = (response: { content: Array<{ type: "text"; text: string }> }) => {
      const text = response.content?.[0]?.text ?? "{}";
      try {
        return JSON.parse(text);
      } catch {
        return { result: text };
      }
    };

    const workflowSteps: Record<string, unknown> = {};
    const runStep = async (
      stepName: string,
      toolName: string,
      toolArgs: Record<string, unknown>,
      fallbackResult: Record<string, unknown> = {}
    ) => {
      const stepStarted = Date.now();
      try {
        const payload = parseToolPayload(await callBackendTool(toolName, toolArgs));
        if (payload && typeof payload === "object" && payload.error) {
          workflowSteps[stepName] = {
            status: "error",
            tool: toolName,
            latency_ms: Date.now() - stepStarted,
            error: payload.error,
            error_code: payload.error_code || "STEP_ERROR",
            next_step: payload.next_step || `Retry ${toolName}.`,
          };
          return { ok: false, payload };
        }
        workflowSteps[stepName] = {
          status: "ok",
          tool: toolName,
          latency_ms: Date.now() - stepStarted,
          ...(payload || fallbackResult),
        };
        return { ok: true, payload };
      } catch (error) {
        workflowSteps[stepName] = {
          status: "error",
          tool: toolName,
          latency_ms: Date.now() - stepStarted,
          error: String(error),
          error_code: "STEP_EXCEPTION",
        };
        return { ok: false, payload: { error: String(error), error_code: "STEP_EXCEPTION" } };
      }
    };

    if (typeof query === "string" && query.trim().length > 0) {
      const searchRes = await runStep("search", "search", {
        pattern: query.trim(),
        path: workspace,
        page_size: typeof page_size === "number" ? page_size : 20,
      });
      if (searchRes.ok && searchRes.payload && typeof searchRes.payload === "object") {
        const items = extractSearchLikeItems(searchRes.payload);
        workflowSteps.search = {
          ...(workflowSteps.search as Record<string, unknown>),
          count: extractSearchLikeCount(searchRes.payload, items),
          preview: items.slice(0, typeof page_size === "number" ? page_size : 20),
          cursor_available: !!searchRes.payload?.next?.arguments?.cursor,
          truncated: !!searchRes.payload?.page?.has_more,
        };
      }
    }

    const definitionRes = await runStep("definition", "definition", { file: absFile, line, column });
    const referencesRes = await runStep("references", "references", {
      file: absFile,
      line,
      column,
      page_size: typeof reference_preview === "number" ? reference_preview : 20,
    });
    const hintsRes = await runStep("read_file_with_hints", "read_file_with_hints", {
      file: absFile,
      start_line: typeof hint_start_line === "number" ? hint_start_line : 1,
      max_lines: typeof hint_max_lines === "number" ? hint_max_lines : 120,
    });

    const referencesPayload = referencesRes.payload && typeof referencesRes.payload === "object" ? referencesRes.payload : {};
    const referenceItems = extractReferencesItems(referencesPayload);
    const referenceCount = extractReferencesCount(referencesPayload, referenceItems);

    const ok = Boolean(definitionRes.ok || referencesRes.ok || hintsRes.ok);
    const nextStep = ok
      ? "Continue with code_action/rename based on references and hints."
      : `Retry semantic_navigate after running doctor(probe_backends=true) and checking workspace/dependencies for '${language}'.`;
    const recoveryPlan = ok
      ? []
      : buildRecoveryPlan(
          [`doctor(probe_backends=true, check_latest_versions=true)`, `switch_workspace_for_language(language='${language}', path='${workspace}')`],
          nextStep
        );
    const result = withStandardCostFields({
      ok,
      tool: "semantic_navigate",
      strict_mode: true,
      file: absFile,
      position: { line, column },
      resolved_language: language,
      resolved_workspace: workspace,
      backend_instance_id: backendInstanceId,
      steps: workflowSteps,
      summary: {
        references_count: referenceCount,
        definition_ok: definitionRes.ok,
        references_ok: referencesRes.ok,
        hints_ok: hintsRes.ok,
      },
      next_step: nextStep,
      recovery_plan: recoveryPlan,
      latency_ms: Date.now() - startedAt,
      result_size: referenceCount,
      cursor_available: !!(referencesPayload as Record<string, any>)?.next?.arguments?.cursor,
      truncated: !!(referencesPayload as Record<string, any>)?.page?.has_more,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }
);

server.registerTool(
  "doctor",
  {
    description: "Run environment and backend readiness checks for out-of-box troubleshooting.",
    inputSchema: {
      probe_backends: z.boolean().default(false).optional(),
      check_latest_versions: z.boolean().default(false).optional(),
      page_size: z.number().int().positive().default(50).optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ probe_backends, check_latest_versions, page_size, cursor }) => {
    const pageSize = typeof page_size === "number" ? page_size : 50;
    if (typeof cursor === "string") {
      const page = readCursorPage("doctor", cursor, pageSize);
      if (!page.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify(page.data) }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            items: page.data.items,
            count: page.data.count,
            summary: page.data.summary,
            page: page.data.page,
            next: page.data.page.has_more
              ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
              : null,
          }),
        }],
      };
    }

    const checkCommand = (command: string, versionArgs = ["--version"]) => {
      try {
        const out = spawnSync(command, versionArgs, {
          encoding: "utf-8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return {
          available: out.status === 0,
          code: out.status,
          output: (out.stdout || out.stderr || "").trim().split("\n")[0],
        };
      } catch (error) {
        return {
          available: false,
          code: -1,
          output: String(error),
        };
      }
    };

    const checks = {
      node: checkCommand("node"),
      npm: checkCommand("npm"),
      npx: checkCommand("npx"),
      uv: checkCommand("uv"),
      bun: checkCommand("bun"),
    };

    const backendPackages = getBackendPackages(config).filter((pkg) => config.languages[pkg.language]?.enabled);
    const backendRuntimeMode = resolveBackendRuntimeMode();
    const versionByLanguage = new Map(backendManager.getVersions().map((version) => [version.language, version]));
    const parseSemver = (raw: string | null): string | null => {
      if (!raw) return null;
      const m = raw.match(/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
      return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
    };
    const compareSemver = (left: string, right: string): number => {
      const a = left.split(".").map((x) => Number.parseInt(x, 10));
      const b = right.split(".").map((x) => Number.parseInt(x, 10));
      for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) > (b[i] || 0)) return 1;
        if ((a[i] || 0) < (b[i] || 0)) return -1;
      }
      return 0;
    };
    const fetchLatestRegistryVersion = async (
      pkg: { package: string; registry: "npm" | "pypi"; resolver: "npx" | "uvx" }
    ): Promise<RegistryLookupResult> => {
      if (!check_latest_versions) {
        return { latest_version: null, source: "unknown", error: "latest check disabled (set check_latest_versions=true)" };
      }
      const cacheKey = `${pkg.registry}:${pkg.package}`;
      const now = Date.now();
      const cached = registryLatestCache.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.value;
      const inflight = registryLatestInflight.get(cacheKey);
      if (inflight) return await inflight;
      const lookup = (async (): Promise<RegistryLookupResult> => {
        if (pkg.registry === "npm") {
          if (!checks.npm.available) {
            return { latest_version: null, source: "npm", error: "npm not available" };
          }
          const out = await runCommandCapture("npm", ["view", pkg.package, "version"], 5000);
          if (out.code !== 0) {
            return { latest_version: null, source: "npm", error: (out.stderr || out.stdout || "npm view failed").trim() };
          }
          const latest = String(out.stdout || "").trim().split("\n")[0] || null;
          return { latest_version: parseSemver(latest), source: "npm", error: latest ? undefined : "empty version response" };
        }
        return { latest_version: null, source: "pypi", error: "pypi latest lookup not implemented" };
      })();
      registryLatestInflight.set(cacheKey, lookup);
      try {
        const value = await lookup;
        registryLatestCache.set(cacheKey, { value, expiresAt: now + REGISTRY_LOOKUP_TTL_MS });
        return value;
      } finally {
        registryLatestInflight.delete(cacheKey);
      }
    };
    const latestLookupStats = {
      schema_version: 1,
      enabled: !!check_latest_versions,
      cache_ttl_ms: REGISTRY_LOOKUP_TTL_MS,
      requested: 0,
      cache_hits: 0,
      inflight_hits: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };
    const fetchLatestWithStats = async (
      pkg: { package: string; registry: "npm" | "pypi"; resolver: "npx" | "uvx" }
    ): Promise<RegistryLookupResult> => {
      latestLookupStats.requested += 1;
      if (!check_latest_versions) {
        latestLookupStats.skipped += 1;
        return { latest_version: null, source: "unknown", error: "latest check disabled (set check_latest_versions=true)" };
      }
      const cacheKey = `${pkg.registry}:${pkg.package}`;
      const now = Date.now();
      const cached = registryLatestCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        latestLookupStats.cache_hits += 1;
        return cached.value;
      }
      if (registryLatestInflight.has(cacheKey)) {
        latestLookupStats.inflight_hits += 1;
      } else {
        latestLookupStats.executed += 1;
      }
      const result = await fetchLatestRegistryVersion(pkg);
      if (result.latest_version) latestLookupStats.succeeded += 1;
      else latestLookupStats.failed += 1;
      return result;
    };
    const backendPackageDriftEntries = await Promise.all(
      backendPackages.map(async (pkg) => {
        const versionInfo = versionByLanguage.get(pkg.language);
        const backendStatus = versionInfo?.status ?? "not_started";
        const command = versionInfo?.command ?? "not configured";
        const installedVersion = versionInfo?.installed ?? null;
        const bundledRuntime = command.includes("/dist/bundled/");
        const usingLatestPolicy = pkg.registry === "npm"
          ? command.includes("@latest")
          : command.includes("--upgrade");
        const latestRegistry = await fetchLatestWithStats(pkg);
        const installedSemver = parseSemver(installedVersion);
        const latestSemver = parseSemver(latestRegistry.latest_version);
        const minimumSupportedSemver = parseSemver(pkg.minimum_supported_version);

        let driftStatus: "unknown_not_started" | "bundled_static" | "policy_aligned" | "policy_drift" = "unknown_not_started";
        if (backendStatus === "ready" || backendStatus === "error") {
          if (bundledRuntime) driftStatus = "bundled_static";
          else if (usingLatestPolicy) driftStatus = "policy_aligned";
          else driftStatus = "policy_drift";
        }
        const latestStatus: "up_to_date" | "outdated" | "unknown_not_started" | "unknown_no_latest" | "unknown_parse_failed" | "unknown_skipped" =
          backendStatus !== "ready" && backendStatus !== "error"
            ? "unknown_not_started"
            : !check_latest_versions
              ? "unknown_skipped"
            : !installedSemver
              ? "unknown_parse_failed"
              : !latestSemver
                ? "unknown_no_latest"
                : compareSemver(installedSemver, latestSemver) >= 0
                  ? "up_to_date"
                  : "outdated";
        const minimumStatus: "supported" | "below_minimum" | "unknown_not_started" | "unknown_parse_failed" =
          backendStatus !== "ready" && backendStatus !== "error"
            ? "unknown_not_started"
            : !installedSemver || !minimumSupportedSemver
              ? "unknown_parse_failed"
              : compareSemver(installedSemver, minimumSupportedSemver) >= 0
                ? "supported"
                : "below_minimum";

        const nextStep = driftStatus === "policy_aligned"
          ? "No action needed."
          : driftStatus === "bundled_static"
            ? "Rebuild bundled backends to refresh pinned runtime: bun run build:bundled"
            : driftStatus === "policy_drift"
              ? `Upgrade via: ${pkg.update_command}`
              : `Start backend '${pkg.language}' and run doctor again to verify installed version.`;
        const versionNextStep = latestStatus === "outdated"
          ? `Installed ${installedSemver} is behind latest ${latestSemver}. Upgrade via: ${pkg.update_command}`
          : latestStatus === "unknown_no_latest"
              ? "Could not resolve latest registry version. Re-run doctor with network access."
              : latestStatus === "unknown_parse_failed"
                ? "Installed version string is non-semver. Ensure backend is started and version is reported cleanly."
                : latestStatus === "unknown_skipped"
                  ? "Run doctor(check_latest_versions=true) to compare installed versions with latest registry versions."
                : latestStatus === "unknown_not_started"
                  ? `Start backend '${pkg.language}' to compare installed version with latest.`
                  : "Installed version matches latest policy.";

        return [pkg.language, {
          language: pkg.language,
          backend_status: backendStatus,
          installed_version: installedVersion,
          package_ref: pkg.package_ref,
          resolver: pkg.resolver,
          configured_command: command,
          runtime_mode: backendRuntimeMode,
          latest_policy: pkg.default_channel,
          drift_status: driftStatus,
          latest_registry_version: latestSemver,
          latest_registry_source: latestRegistry.source,
          latest_lookup_error: latestRegistry.error || null,
          installed_semver: installedSemver,
          minimum_supported_version: pkg.minimum_supported_version,
          minimum_status: minimumStatus,
          latest_status: latestStatus,
          latest_next_step: versionNextStep,
          update_command: pkg.update_command,
          next_step: nextStep,
        }];
      })
    );
    const backendPackageDrift = Object.fromEntries(backendPackageDriftEntries);
    const backendVersionCounts = {
      languages: backendPackageDriftEntries.length,
      below_minimum: 0,
      outdated: 0,
      policy_drift: 0,
      bundled_static: 0,
      unknown_latest: 0,
    };
    const backendVersionByLanguage = Object.fromEntries(
      backendPackageDriftEntries.map(([lang, drift]) => {
        const value = drift as Record<string, any>;
        if (value.minimum_status === "below_minimum") backendVersionCounts.below_minimum += 1;
        if (value.latest_status === "outdated") backendVersionCounts.outdated += 1;
        if (value.drift_status === "policy_drift") backendVersionCounts.policy_drift += 1;
        if (value.drift_status === "bundled_static") backendVersionCounts.bundled_static += 1;
        if (String(value.latest_status || "").startsWith("unknown")) backendVersionCounts.unknown_latest += 1;
        return [lang, {
          installed_version: value.installed_version,
          installed_semver: value.installed_semver,
          minimum_supported_version: value.minimum_supported_version,
          minimum_status: value.minimum_status,
          latest_registry_version: value.latest_registry_version,
          latest_status: value.latest_status,
          drift_status: value.drift_status,
          update_command: value.update_command,
          next_step: value.latest_next_step || value.next_step,
        }];
      })
    );
    const backendVersionSummary = {
      schema_version: 1,
      check_latest_versions: !!check_latest_versions,
      lookup_stats: latestLookupStats,
      counts: backendVersionCounts,
      by_language: backendVersionByLanguage,
    };

    const workspaceDependencyChecks: Record<string, unknown> = {};
    if (config.languages.vue?.enabled) {
      const vueRoots = detectVueProjectRoots(activeWorkspacePath);
      const vueProjects = vueRoots.map(checkVueProjectDeps);
      workspaceDependencyChecks.vue = {
        strict_mode: VUE_STRICT_SEMANTIC,
        workspace: activeWorkspacePath,
        project_count: vueProjects.length,
        projects: vueProjects,
        note: !activeWorkspacePath
          ? "Call switch_workspace(path=...) to run Vue project dependency checks."
          : undefined,
      };
    }

    const uvCacheDir = process.env.UV_CACHE_DIR || path.join("/tmp", "lsp-mcp-uv-cache");
    let uvCacheWritable = false;
    try {
      fs.mkdirSync(uvCacheDir, { recursive: true });
      fs.accessSync(uvCacheDir, fs.constants.W_OK);
      uvCacheWritable = true;
    } catch {
      uvCacheWritable = false;
    }
    workspaceDependencyChecks.python = {
      uv_cache_dir: uvCacheDir,
      uv_cache_writable: uvCacheWritable,
    };

    const discoveryRoot = activeWorkspacePath;
    if (discoveryRoot && fileExistsSafe(discoveryRoot) && fs.statSync(discoveryRoot).isDirectory()) {
      const candidates = discoverWorkspaceCandidates(discoveryRoot, 2);
      const picked: Record<Language, WorkspaceCandidate | null> = {
        python: pickLanguageWorkspace("python", candidates, discoveryRoot),
        typescript: pickLanguageWorkspace("typescript", candidates, discoveryRoot),
        vue: pickLanguageWorkspace("vue", candidates, discoveryRoot),
      };
      const suggestions: Record<Language, string | null> = {
        python: picked.python?.dir || null,
        typescript: picked.typescript?.dir || null,
        vue: picked.vue?.dir || null,
      };
      const commands = (Object.keys(suggestions) as Language[])
        .filter((lang) => !!suggestions[lang])
        .map((lang) => `switch_workspace_for_language(language='${lang}', path='${suggestions[lang]}')`);

      workspaceDependencyChecks.language_workspace_discovery = {
        root: discoveryRoot,
        candidates_found: candidates.length,
        suggestions,
        commands,
        current_overrides: {
          python: getWorkspaceOverride("python"),
          typescript: getWorkspaceOverride("typescript"),
          vue: getWorkspaceOverride("vue"),
        },
      };
    } else {
      workspaceDependencyChecks.language_workspace_discovery = {
        root: discoveryRoot,
        suggestions: null,
        commands: [],
        note: "Set a root workspace first to enable language workspace discovery.",
      };
    }

    const enabledLanguages = Object.keys(config.languages).filter((lang) => config.languages[lang]?.enabled);
    const workspaceDiscovery = workspaceDependencyChecks.language_workspace_discovery as
      | { suggestions: Record<string, string | null> | null; commands: string[]; current_overrides?: Record<string, string | null> }
      | undefined;
    const vueChecks = workspaceDependencyChecks.vue as {
      projects?: Array<{
        root: string;
        ok: boolean;
        missing_packages?: string[];
        install_commands?: string[];
        install_example?: string;
      }>;
    } | undefined;

    const languageCommandChains = Object.fromEntries(
      enabledLanguages.map((lang) => {
        const language = lang as Language;
        const overrideWorkspace = getWorkspaceOverride(language);
        const suggestedWorkspace = workspaceDiscovery?.suggestions?.[language] ?? null;
        const targetWorkspace = overrideWorkspace || suggestedWorkspace || activeWorkspacePath || null;
        const commands: string[] = [];
        const missingPackages: string[] = [];
        let dependencyStatus: "ok" | "missing" | "unknown" = "ok";

        if (!activeWorkspacePath) {
          commands.push("switch_workspace(path='/abs/monorepo/root')");
        }
        if (!overrideWorkspace && targetWorkspace) {
          commands.push(`switch_workspace_for_language(language='${language}', path='${targetWorkspace}')`);
        }

        if (language === "vue") {
          const vueProjects = vueChecks?.projects || [];
          const matchedProject =
            vueProjects.find((p) => targetWorkspace && (p.root === targetWorkspace || targetWorkspace.startsWith(p.root) || p.root.startsWith(targetWorkspace))) ||
            vueProjects[0];
          if (matchedProject && !matchedProject.ok) {
            dependencyStatus = "missing";
            for (const pkg of matchedProject.missing_packages || []) {
              if (!missingPackages.includes(pkg)) missingPackages.push(pkg);
            }
            const installCmd = matchedProject.install_commands?.[0] || matchedProject.install_example;
            if (installCmd) commands.push(installCmd);
          } else if (!matchedProject) {
            dependencyStatus = "unknown";
          }
          commands.push("hover(file='/abs/path/to/component.vue', line=1, column=1)");
        } else if (language === "python") {
          if (!uvCacheWritable) {
            dependencyStatus = "missing";
            commands.push(`export UV_CACHE_DIR='${uvCacheDir}'`);
          }
          commands.push("hover(file='/abs/path/to/module.py', line=1, column=1)");
        } else if (language === "typescript") {
          commands.push("hover(file='/abs/path/to/file.ts', line=1, column=1)");
        }

        return [language, {
          language,
          workspace: targetWorkspace,
          workspace_configured: !!overrideWorkspace,
          dependency_status: dependencyStatus,
          missing_packages: missingPackages,
          commands,
        }];
      })
    );
    workspaceDependencyChecks.language_command_chains = languageCommandChains;
    const backendCommands = Object.fromEntries(
      enabledLanguages.map((lang) => {
        const cmd = backendManager.getVersions().find((v) => v.language === lang)?.command ?? "not configured";
        return [lang, cmd];
      })
    );

    const featureCommandTemplate = (lang: Language, feature: string, workspace: string | null) => {
      const sampleFile =
        findSampleFileForLanguage(workspace, lang) ||
        (lang === "python"
          ? "/abs/path/to/module.py"
          : lang === "vue"
            ? "/abs/path/to/component.vue"
            : "/abs/path/to/file.ts");
      if (feature === "semantic_tokens") return `semantic_tokens(file='${sampleFile}')`;
      if (feature === "linked_editing_range") return `linked_editing_range(file='${sampleFile}', line=1, column=1)`;
      if (feature === "moniker") return `moniker(file='${sampleFile}', line=1, column=1)`;
      if (feature === "inlay_hint_resolve") return `inlay_hint_resolve(file='${sampleFile}', line=1, column=1)`;
      if (feature === "read_file_with_hints") return `read_file_with_hints(file='${sampleFile}', start_line=1, max_lines=80)`;
      if (feature === "call_hierarchy") return `call_hierarchy(file='${sampleFile}', line=1, column=1, direction='both')`;
      return `hover(file='${sampleFile}', line=1, column=1)`;
    };
    const featureCapabilityMatrix: Record<string, any> = {};
    for (const lang of enabledLanguages) {
      const language = lang as Language;
      const chainWorkspace = (languageCommandChains[language] as { workspace?: string | null } | undefined)?.workspace || null;
      if (!probe_backends) {
        const featureNextSteps = Object.fromEntries(
          LLM_FEATURE_TARGETS.map((feature) => {
            const meta = LLM_FEATURE_PROBE_METADATA[feature];
            return [
              feature,
              {
                status: "unknown",
                command: featureCommandTemplate(language, feature, chainWorkspace),
                note: "Run doctor(probe_backends=true) for backend capability verification.",
                expected_latency_ms: meta.expected_latency_ms,
                failure_signatures: meta.failure_signatures,
              },
            ];
          })
        );
        featureCapabilityMatrix[lang] = {
          probe_required: true,
          status: "unknown",
          next_step: "Call doctor(probe_backends=true) to fetch per-language feature capabilities.",
          feature_next_steps: featureNextSteps,
        };
        continue;
      }
      try {
        const tools = await backendManager.getTools(language);
        const toolSet = new Set(tools.map((t) => t.name));
        const features = Object.fromEntries(
          LLM_FEATURE_TARGETS.map((name) => [
            name,
            toolSet.has(name) ? "supported" : "not_supported",
          ])
        );
        const featureNextSteps = Object.fromEntries(
          LLM_FEATURE_TARGETS.map((feature) => {
            const supported = toolSet.has(feature);
            const command = featureCommandTemplate(language, feature, chainWorkspace);
            const meta = LLM_FEATURE_PROBE_METADATA[feature];
            return [
              feature,
              supported
                ? {
                    status: "supported",
                    command,
                    note: `Run ${feature} directly after workspace setup.`,
                    expected_latency_ms: meta.expected_latency_ms,
                    failure_signatures: meta.failure_signatures,
                  }
                : {
                    status: "not_supported",
                    command,
                    fallback_command: "hover(file='/abs/path/to/file', line=1, column=1)",
                    note: "Feature missing in backend; expect strict NOT_IMPLEMENTED.",
                    expected_latency_ms: meta.expected_latency_ms,
                    failure_signatures: meta.failure_signatures,
                  },
            ];
          })
        );
        featureCapabilityMatrix[lang] = {
          status: "ok",
          tool_count: tools.length,
          features,
          feature_next_steps: featureNextSteps,
        };
      } catch (error) {
        featureCapabilityMatrix[lang] = {
          status: "error",
          error: String(error),
        };
      }
    }

    const probeResults: Record<string, any> = {};
    if (probe_backends) {
      for (const lang of enabledLanguages) {
        try {
          await backendManager.getBackend(lang);
          startedBackends.add(lang);
          probeResults[lang] = { ok: true };
        } catch (error) {
          probeResults[lang] = { ok: false, error: String(error) };
        }
      }
    }

    const recommendations: string[] = [];
    if (!checks.node.available) recommendations.push("Install Node.js and ensure `node` is in PATH.");
    if (!checks.npx.available) recommendations.push("Ensure npm/npx is available in PATH.");
    if (!checks.uv.available && config.languages.python?.enabled) recommendations.push("Install uv for Python backend support.");
    if (!checks.bun.available) recommendations.push("Install Bun if you run this server from source.");
    if (config.languages.vue?.enabled && activeWorkspacePath) {
      const missing = (vueChecks?.projects || []).filter((p) => !p.ok);
      if (missing.length > 0) {
        recommendations.push("Vue strict semantic mode is enabled and some Vue projects are missing runtime dependencies.");
        for (const project of missing) {
          recommendations.push(`Install Vue semantic deps: ${project.install_commands?.[0] || project.install_example}`);
        }
      }
    }
    if (config.languages.python?.enabled && !uvCacheWritable) {
      recommendations.push(`UV cache directory is not writable: ${uvCacheDir}. Set UV_CACHE_DIR to a writable path.`);
    }
    if (!activeWorkspacePath) {
      recommendations.push("Set a root workspace first, then run doctor again to discover per-language workspaces.");
    } else if (workspaceDiscovery?.suggestions) {
      const missingMappings = (Object.keys(config.languages) as Language[])
        .filter((lang) => config.languages[lang]?.enabled)
        .filter((lang) => !getWorkspaceOverride(lang))
        .filter((lang) => !!workspaceDiscovery.suggestions?.[lang]);
      if (missingMappings.length > 0) {
        recommendations.push(
          `Language workspaces are recommended for semantic tools. Missing mappings: ${missingMappings.join(", ")}.`
        );
        for (const cmd of workspaceDiscovery.commands) {
          recommendations.push(`Suggested command: ${cmd}`);
        }
      }
    }
    if (probe_backends && probeResults.python?.ok === false) {
      const pythonProbeError = String(probeResults.python?.error || "");
      if (pythonProbeError.includes("Connection closed") || pythonProbeError.includes("MCP error -32000")) {
        recommendations.push("Python backend failed before handshake. Run `uv run --directory dist/bundled/python python-lsp-mcp --help` to preinstall runtime dependencies.");
      }
    }
    for (const [lang, drift] of Object.entries(backendPackageDrift as Record<string, any>)) {
      if (drift.drift_status === "policy_drift") {
        recommendations.push(`${lang} backend is not using latest update policy. ${drift.next_step}`);
      } else if (drift.drift_status === "bundled_static") {
        recommendations.push(`${lang} backend runs from bundled runtime and may drift from latest. ${drift.next_step}`);
      }
      if (drift.latest_status === "outdated") {
        recommendations.push(`${lang} backend is behind latest registry version. ${drift.latest_next_step}`);
      }
      if (drift.minimum_status === "below_minimum") {
        recommendations.push(`${lang} backend is below minimum supported version ${drift.minimum_supported_version}. Upgrade via: ${drift.update_command}`);
      }
    }

    const result = {
      ok: recommendations.length === 0,
      checks,
      activeWorkspacePath,
      backendRuntimeMode: backendRuntimeMode,
      enabledLanguages,
      backendPackageDrift,
      backendVersionSummary,
      workspaceDependencyChecks,
      languageCommandChains,
      backendCommands,
      featureCapabilityMatrix,
      probe_backends: !!probe_backends,
      check_latest_versions: !!check_latest_versions,
      probeResults: probe_backends ? probeResults : undefined,
      recommendations,
    };

    const items: Array<{ kind: string; key: string; value: unknown }> = [];
    for (const [name, check] of Object.entries(checks)) {
      items.push({ kind: "runtime_check", key: name, value: check });
    }
    for (const [name, depCheck] of Object.entries(workspaceDependencyChecks)) {
      items.push({ kind: "workspace_dependency", key: name, value: depCheck });
    }
    for (const [lang, chain] of Object.entries(languageCommandChains)) {
      items.push({ kind: "language_command_chain", key: lang, value: chain });
    }
    for (const [lang, command] of Object.entries(backendCommands)) {
      items.push({ kind: "backend_command", key: lang, value: command });
    }
    for (const [lang, matrix] of Object.entries(featureCapabilityMatrix)) {
      items.push({ kind: "feature_capability", key: lang, value: matrix });
    }
    for (const [lang, drift] of Object.entries(backendPackageDrift as Record<string, unknown>)) {
      items.push({ kind: "backend_package_drift", key: lang, value: drift });
    }
    for (const [lang, probe] of Object.entries(probeResults)) {
      items.push({ kind: "backend_probe", key: lang, value: probe });
    }
    recommendations.forEach((rec, idx) => {
      items.push({ kind: "recommendation", key: `r${idx + 1}`, value: rec });
    });

    const doctorSummary = {
      ok: result.ok,
      activeWorkspacePath,
      enabledLanguages,
      recommendations_count: recommendations.length,
      command_chains_count: Object.keys(languageCommandChains).length,
      backend_version_schema_version: backendVersionSummary.schema_version,
      backend_version_counts: backendVersionSummary.counts,
      item_count: items.length,
    };
    const doctorCursor = makeCursor("doctor", items, items.length, doctorSummary);
    const firstPage = readCursorPage("doctor", doctorCursor, pageSize);
    if (!firstPage.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(firstPage.data) }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...result,
          items: firstPage.data.items,
          page: firstPage.data.page,
          next: firstPage.data.page.has_more
            ? { tool: "expand_result", arguments: { cursor: firstPage.data.page.next_cursor, page_size: pageSize } }
            : null,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "lsp_probe_profile",
  {
    description: "Get LLM-oriented probe profile metadata (feature order, expected latency, failure signatures).",
    inputSchema: {
      language: z.enum(["python", "typescript", "vue"]).optional(),
      feature: z.string().optional(),
    },
  },
  async ({ language, feature }) => {
    const phaseByFeature: Record<string, "p0_bootstrap" | "p1_context" | "p2_advanced"> = {
      hover: "p0_bootstrap",
      definition: "p0_bootstrap",
      references: "p1_context",
      read_file_with_hints: "p1_context",
      semantic_tokens: "p2_advanced",
      moniker: "p2_advanced",
      linked_editing_range: "p2_advanced",
      inlay_hint_resolve: "p2_advanced",
      call_hierarchy: "p2_advanced",
    };
    const selectedFeatures = feature
      ? [feature]
      : [...LLM_FEATURE_TARGETS, "hover", "definition", "references"];
    const uniqueFeatures = Array.from(new Set(selectedFeatures)).filter(
      (name) => LLM_FEATURE_PROBE_METADATA[name as keyof typeof LLM_FEATURE_PROBE_METADATA]
    );
    const profile = uniqueFeatures.map((name) => ({
      feature: name,
      phase: phaseByFeature[name] || "p2_advanced",
      ...(LLM_FEATURE_PROBE_METADATA[name as keyof typeof LLM_FEATURE_PROBE_METADATA]),
    }));

    const perLanguage = language
      ? { [language]: profile }
      : {
          python: profile,
          typescript: profile,
          vue: profile,
        };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          profile_version: 1,
          language: language || "all",
          features: uniqueFeatures,
          per_language: perLanguage,
          source: "lsp-mcp",
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "expand_result",
  {
    description: "Fetch the next page for a previously paged response using its cursor.",
    inputSchema: {
      cursor: z.string().describe("Cursor returned by a previous paged response"),
      page_size: z.number().int().positive().default(200).optional(),
    },
  },
  async ({ cursor, page_size }) => {
    const pageSize = typeof page_size === "number" ? page_size : 200;
    const page = readCursorPageAny(cursor, pageSize);
    if (!page.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(page.data) }],
      };
    }

    const payload: Record<string, unknown> = {
      tool: page.tool,
      items: page.data.items,
      count: page.data.count,
      summary: page.data.summary,
      page: page.data.page,
      next: page.data.page.has_more
        ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
        : null,
    };
    if (page.tool === "diagnostics") payload.diagnostics = page.data.items;
    if (page.tool === "references") payload.references = page.data.items;
    if (page.tool === "search" || page.tool === "workspace_symbol") {
      payload.matches = page.data.items;
      payload.resolved_language = page.data.summary?.resolved_language ?? null;
      payload.resolved_workspace = page.data.summary?.resolved_workspace ?? null;
      payload.resolved_workspaces = page.data.summary?.resolved_workspaces ?? null;
    }
    if (page.tool === "diagnostics" || page.tool === "references") {
      payload.resolved_language = page.data.summary?.resolved_language ?? null;
      payload.resolved_workspace = page.data.summary?.resolved_workspace ?? null;
    }
    if (page.tool === "project_structure" || page.tool === "summarize_file" || page.tool === "read_file_with_hints") {
      payload.lines = page.data.items;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  }
);

server.registerTool(
  "switch_python_backend",
  {
    description: "Switch the Python backend provider (requires restart)",
    inputSchema: switchPythonBackendSchema,
  },
  async ({ provider }) => switchPythonBackend(provider as PythonProvider)
);

server.registerTool(
  "list_backends",
  {
    description: "List available backends and their status. Shows which backends are installed, running, and how many tools they provide.",
  },
  async () => listBackendsTool(backendManager, config)
);

server.registerTool(
  "start_backend",
  {
    description: "Start a backend and register its tools. This will download and install the backend if needed, then make its tools available.",
    inputSchema: startBackendSchema,
  },
  async ({ language }) => startBackendTool(
    language as "python" | "typescript" | "vue",
    backendManager,
    config,
    startAndRegisterBackend
  )
);

server.registerTool(
  "update_backend",
  {
    description: "Update a backend to the latest version. This will restart the backend with the newest version available.",
    inputSchema: updateBackendSchema,
  },
  async ({ language }) => updateBackendTool(
    language as "python" | "typescript" | "vue",
    backendManager,
    config,
    updateAndRestartBackend
  )
);

// ============================================================================ 
// Unified Tool Routing
// ============================================================================ 

/**
 * Standard LSP tools that are unified across all languages.
 * Routing is done automatically based on the 'file' or 'path' argument.
 */
const UNIFIED_TOOLS: Array<{ 
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}> = [
  { name: "hover", description: "Get type information and documentation at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "definition", description: "Go to definition of a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "implementation", description: "Go to implementation of a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "type_definition", description: "Go to type definition of a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "call_hierarchy", description: "Get incoming/outgoing call hierarchy at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), direction: z.enum(["incoming", "outgoing", "both"]).default("both").optional() } },
  { name: "type_hierarchy", description: "Get type hierarchy (supertypes/subtypes) at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), direction: z.enum(["supertypes", "subtypes", "both"]).default("both").optional() } },
  { name: "document_highlight", description: "Find highlights of current symbol in document at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "code_lens", description: "Get compact code-lens style summary at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "selection_range", description: "Get nested smart selection ranges at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "folding_range", description: "Get foldable ranges in a file", schema: { file: z.string() } },
  { name: "document_link", description: "Extract links (imports/requires/URLs) from a file", schema: { file: z.string() } },
  { name: "linked_editing_range", description: "Get linked editing ranges at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "semantic_tokens", description: "Get semantic tokens for a file", schema: { file: z.string() } },
  { name: "moniker", description: "Get moniker-like symbol identity for cross-package tracking", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "inlay_hint_resolve", description: "Resolve an inlay hint at a position for richer context", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), label: z.string().optional() } },
  { name: "references", description: "Find all references to a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "completions", description: "Get code completion suggestions at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), limit: z.number().int().positive().default(20).optional() } },
  { name: "signature_help", description: "Get function signature help at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "symbols", description: "Extract symbols (classes, functions, methods, variables) from a file", schema: { file: z.string(), query: z.string().optional() } },
  { name: "diagnostics", description: "Get type errors/warnings. NOTE: On mixed-language directories, it only checks the primary language (TS > Python). Prefer specific subdirectories or 'git_diagnostics'.", schema: { path: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional(), summary_only: z.boolean().default(false).optional() } },
  { name: "rename", description: "Preview renaming a symbol at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), newName: z.string() } },
  { name: "prepare_rename", description: "Check whether a symbol can be renamed safely at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "update_document", description: "Update file content for incremental analysis without writing to disk", schema: { file: z.string(), content: z.string() } },
  { name: "search", description: "Search for a pattern in files using ripgrep. Uses active workspace if path is omitted.", schema: { pattern: z.string().optional(), query: z.string().optional(), path: z.string().optional(), glob: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "summarize_file", description: "Get a high-level outline of a file (classes, functions, methods) to understand its structure without reading the full content.", schema: { file: z.string(), max_symbols: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "read_file_with_hints", description: "Read file content with inlay hints (type annotations, parameter names) inserted as comments. Useful for understanding complex code.", schema: { file: z.string(), start_line: z.number().int().positive().default(1).optional(), max_lines: z.number().int().positive().default(300).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "code_action", description: "Get available code actions (refactors and quick fixes) at a specific position", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "run_code_action", description: "Apply a code action (refactor or quick fix)", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), kind: z.enum(["refactor", "quickfix"]), name: z.string(), actionName: z.string().optional(), preview: z.boolean().default(false).optional() } },
  { name: "workspace_symbol", description: "Search for a symbol (class, function, etc.) across the entire workspace. Returns locations that can be used with peek_definition.", schema: { query: z.string().optional(), preview_limit: z.number().int().positive().default(200).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "peek_definition", description: "Go to definition and return the surrounding code context immediately. Reduces round-trips compared to definition() + read_file().", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  { name: "project_structure", description: "Get a visual tree structure of the project to understand hierarchy and identify key files. Ignores build artifacts.", schema: { path: z.string().optional(), max_depth: z.number().int().positive().max(10).default(3).optional(), max_entries: z.number().int().positive().default(300).optional(), page_size: z.number().int().positive().default(200).optional(), cursor: z.string().optional() } },
  { name: "git_diagnostics", description: "Check for errors/warnings ONLY in files changed in Git (working tree + staged). Useful for checking your changes.", schema: { } },
];

/**
 * Helper to apply inlay hints to file content.
 */
function applyInlayHints(content: string, hints: any[], language: string): string {
  const lines = content.split('\n');
  // Copy to avoid mutating original split array if we used it elsewhere (safety)
  const resultLines = [...lines];
  
  // Normalize and sort hints reverse
  const normalizedHints = hints.map(h => {
    let line: number, char: number;
    let label = "";
    
    // Extract label
    if (typeof h.label === 'string') label = h.label;
    else if (Array.isArray(h.label)) label = h.label.map((p: any) => p.value).join('');
    
    // Extract position
    if (language === 'typescript') {
        // TS backend wrapper returns { position: { line, column } } (1-based)
        // See backends/typescript/src/index.ts
        line = h.position.line - 1;
        char = h.position.column - 1;
    } else {
        // Python/Vue backends return raw LSP { position: { line, character } } (0-based)
        line = h.position.line;
        char = h.position.character;
    }
    
    return { line, char, label, kind: h.kind, paddingLeft: h.paddingLeft, paddingRight: h.paddingRight };
  }).sort((a, b) => {
    if (a.line !== b.line) return b.line - a.line;
    return b.char - a.char;
  });
  
  for (const hint of normalizedHints) {
    if (hint.line < 0 || hint.line >= resultLines.length) continue;
    
    const lineContent = resultLines[hint.line];
    // In strict mode we might check char bounds, but LSP can point past end of line
    if (hint.char < 0) continue; 
    
    // Split line
    const prefix = lineContent.substring(0, hint.char);
    const suffix = lineContent.substring(hint.char);
    
    let hintText = hint.label;
    
    // Formatting style:
    // Kind 1 (Type):   `variable/*: type*/`
    // Kind 2 (Param):  `func(/*name:*/ arg)`
    // Other:           `/*label*/`
    
    let formatted = "";
    if (hint.kind === 1) {
        formatted = `/*: ${hintText.trim()}*/`;
        // Type hints usually need a space before if not present
        if (!hint.paddingLeft && prefix.length > 0 && !prefix.endsWith(" ")) formatted = " " + formatted;
    } else if (hint.kind === 2) {
        formatted = `/*${hintText.trim()}:*/`;
        // Param hints usually need a space after
        if (!hint.paddingRight) formatted = formatted + " ";
    } else {
        formatted = `/*${hintText}*/`;
    }
    
    resultLines[hint.line] = prefix + formatted + suffix;
  }
  
  return resultLines.join('\n');
}

/**
 * Helper to format document symbols into a Markdown outline.
 */
function formatSymbolsToMarkdown(symbols: any[], depth = 0): string {
  let output = "";
  const indent = "  ".repeat(depth);
  
  for (const symbol of symbols) {
    const kind = symbol.kind ? `[${symbol.kind.toLowerCase()}]` : "";
    const line = symbol.range?.start?.line ?? symbol.line ?? "?"; // Handle both standard LSP and flattened format
    
    output += `${indent}- ${kind} ${symbol.name} (line ${line})\n`;
    
    if (symbol.children && symbol.children.length > 0) {
      output += formatSymbolsToMarkdown(symbol.children, depth + 1);
    }
  }
  
  return output;
}

function extractSearchLikeItems(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  const candidates = [parsed.matches, parsed.results, parsed.symbols, parsed.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractSearchLikeCount(parsed: any, items: any[]): number {
  return typeof parsed?.count === "number" ? parsed.count : items.length;
}

function extractReferencesItems(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.references)) return parsed.references;
  return [];
}

function extractReferencesCount(parsed: any, items: any[]): number {
  return typeof parsed?.count === "number" ? parsed.count : items.length;
}

function isInlayHintUnsupportedError(errorText: string): boolean {
  const text = errorText.toLowerCase();
  return (
    text.includes("textdocument/inlayhint") ||
    text.includes("unhandled method") ||
    text.includes("method not found") ||
    text.includes("not implemented") ||
    text.includes("unknown tool") ||
    text.includes("tool not found") ||
    text.includes("inlay_hints") ||
    text.includes("-32601")
  );
}

function extractIdentifierAtPosition(fileContent: string, line: number, column: number): string | null {
  const lines = fileContent.split("\n");
  const lineIdx = line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  const text = lines[lineIdx];
  if (!text) return null;
  const charIdx = Math.max(0, Math.min(column - 1, Math.max(0, text.length - 1)));
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  const nearestToken = (() => {
    const tokenRegex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    let best: { value: string; distance: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = tokenRegex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length - 1;
      const distance = charIdx >= start && charIdx <= end
        ? 0
        : Math.min(Math.abs(charIdx - start), Math.abs(charIdx - end));
      if (!best || distance < best.distance) {
        best = { value: m[0], distance };
      }
    }
    return best;
  })();

  if (!nearestToken || nearestToken.distance > 24) {
    return null;
  }

  let anchor = charIdx;
  if (!isWord(text[anchor])) {
    for (let delta = 1; delta <= 24; delta++) {
      const left = anchor - delta;
      const right = anchor + delta;
      if (left >= 0 && isWord(text[left])) {
        anchor = left;
        break;
      }
      if (right < text.length && isWord(text[right])) {
        anchor = right;
        break;
      }
    }
  }

  if (!isWord(text[anchor])) {
    return nearestToken.value;
  }

  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  const ident = text.slice(start, end).trim();
  return ident || nearestToken.value;
}

function buildVueFallbackSymbols(fileContent: string, query?: string): Array<{ name: string; kind: string; line: number; column: number }> {
  const symbols: Array<{ name: string; kind: string; line: number; column: number }> = [];
  const lines = fileContent.split("\n");
  const pattern = /\b(const|let|var|function|class|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(lines[i])) !== null) {
      const name = match[2];
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: match[1],
        line: i + 1,
        column: match.index + 1,
      });
    }
  }
  return symbols;
}

function findWorkspaceIdentifierHits(identifier: string, workspacePath?: string): Array<{ file: string; line: number; column: number; text: string }> {
  if (!workspacePath || !identifier) return [];
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\b${escaped}\\b`;
  const args = [
    "--no-ignore-vcs",
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "-g",
    "*.vue",
    "-g",
    "*.ts",
    "-g",
    "*.d.ts",
    "-g",
    "*.tsx",
    "-g",
    "*.js",
    "-g",
    "*.jsx",
    pattern,
    ".",
  ];
  const result = spawnSync("rg", args, { cwd: workspacePath, encoding: "utf-8" });
  if (result.error || typeof result.stdout !== "string" || result.stdout.trim().length === 0) {
    return [];
  }

  const hits: Array<{ file: string; line: number; column: number; text: string }> = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({
      file: path.join(workspacePath, m[1]),
      line: Number(m[2]),
      column: Number(m[3]),
      text: m[4],
    });
    if (hits.length >= 500) break;
  }
  return hits;
}

function findDeclarationInFile(content: string, identifier: string): { line: number; column: number } | null {
  const lines = content.split("\n");
  const declarationPatterns = [
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${identifier}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*=`),
    new RegExp(`\\bimport\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\b`),
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const declarationPattern of declarationPatterns) {
      const m = declarationPattern.exec(lines[i]);
      if (!m) continue;
      return { line: i + 1, column: m.index + 1 };
    }
  }
  return null;
}

function workspaceVueSemanticDepsAvailable(workspacePath?: string | null): boolean {
  if (!workspacePath) return false;
  let current = path.isAbsolute(workspacePath) ? workspacePath : path.resolve(workspacePath);
  if (!fs.existsSync(current)) return false;
  if (!fs.statSync(current).isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    const hasTypeScript = fs.existsSync(path.join(current, "node_modules", "typescript", "lib", "tsserver.js"));
    const hasLanguageServer = fs.existsSync(path.join(current, "node_modules", "@vue", "language-server"));
    if (hasTypeScript && hasLanguageServer) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return false;
}

function hasVueFileInDir(dirPath: string): boolean {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: dirPath, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".vue")) return true;
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      if (depth < 2) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

function detectVueProjectRoots(workspacePath?: string | null): string[] {
  if (!workspacePath) return [];
  let root = path.isAbsolute(workspacePath) ? workspacePath : path.resolve(workspacePath);
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) {
    root = path.dirname(root);
  }

  const candidates = [root];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      candidates.push(path.join(root, entry.name));
    }
  } catch {
    // ignore and keep root-only candidate
  }

  const results: string[] = [];
  for (const dir of candidates) {
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    const hasVueConfig =
      fs.existsSync(path.join(dir, "vite.config.ts")) ||
      fs.existsSync(path.join(dir, "vite.config.js")) ||
      fs.existsSync(path.join(dir, "vue.config.js")) ||
      fs.existsSync(path.join(dir, "nuxt.config.ts"));
    const hasVueSource = hasVueFileInDir(path.join(dir, "src"));
    if (hasPkg && (hasVueConfig || hasVueSource)) {
      results.push(dir);
    }
  }
  return Array.from(new Set(results));
}

function checkVueProjectDeps(projectRoot: string): {
  root: string;
  has_typescript: boolean;
  has_vue_language_server: boolean;
  missing_packages: string[];
  install_commands: string[];
  ok: boolean;
  install_example: string;
} {
  const hasTypeScript = fs.existsSync(path.join(projectRoot, "node_modules", "typescript", "lib", "tsserver.js"));
  const hasVueLs = fs.existsSync(path.join(projectRoot, "node_modules", "@vue", "language-server"));
  const installCommands = [
    `cd ${projectRoot} && pnpm add -D typescript @vue/language-server`,
    `cd ${projectRoot} && npm install -D typescript @vue/language-server`,
    `cd ${projectRoot} && yarn add -D typescript @vue/language-server`,
    `cd ${projectRoot} && bun add -d typescript @vue/language-server`,
  ];
  const missingPackages: string[] = [];
  if (!hasTypeScript) missingPackages.push("typescript");
  if (!hasVueLs) missingPackages.push("@vue/language-server");
  return {
    root: projectRoot,
    has_typescript: hasTypeScript,
    has_vue_language_server: hasVueLs,
    missing_packages: missingPackages,
    install_commands: installCommands,
    ok: hasTypeScript && hasVueLs,
    install_example: installCommands[0],
  };
}

function bundledVueSemanticDepsAvailable(): boolean {
  if (VUE_FORCE_MISSING_SEMANTIC_DEPS) return false;
  if (vueBundledDepsMissingCache !== null) return vueBundledDepsMissingCache;
  try {
    const bundledPkgPath = require.resolve("../dist/bundled/vue/package.json");
    const bundledRoot = path.dirname(bundledPkgPath);
    const hasTypeScript = fs.existsSync(path.join(bundledRoot, "node_modules", "typescript", "lib", "tsserver.js"));
    const hasLanguageServer = fs.existsSync(path.join(bundledRoot, "node_modules", "@vue", "language-server"));
    vueBundledDepsMissingCache = hasTypeScript && hasLanguageServer;
    return vueBundledDepsMissingCache;
  } catch {
    vueBundledDepsMissingCache = false;
    return false;
  }
}

function vueSemanticDepsMissing(workspacePath?: string | null, filePath?: string | null): boolean {
  if (VUE_FORCE_MISSING_SEMANTIC_DEPS) return true;
  if (bundledVueSemanticDepsAvailable()) return false;
  if (workspaceVueSemanticDepsAvailable(workspacePath)) return false;
  if (workspaceVueSemanticDepsAvailable(filePath)) return false;
  return true;
}

function buildVueMissingDepsErrorResponse(
  toolName: string,
  workspacePath?: string | null
): { content: Array<{ type: "text"; text: string }> } {
  const installRoot = workspacePath || "<your-vue-project-root>";
  const installCommands = [
    `cd ${installRoot} && pnpm add -D typescript @vue/language-server`,
    `cd ${installRoot} && npm install -D typescript @vue/language-server`,
    `cd ${installRoot} && yarn add -D typescript @vue/language-server`,
    `cd ${installRoot} && bun add -d typescript @vue/language-server`,
  ];
  const recoveryPlan = buildRecoveryPlan(installCommands, installCommands[0]);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "SEMANTIC_DEPENDENCIES_MISSING",
        error_code: "VUE_SEMANTIC_DEPS_MISSING",
        message: `Vue semantic tool '${toolName}' is unavailable because required dependencies are missing.`,
        code: "VUE_SEMANTIC_DEPS_MISSING",
        language: "vue",
        tool: toolName,
        strict_mode: VUE_STRICT_SEMANTIC,
        missing_packages: ["typescript", "@vue/language-server"],
        install_commands: installCommands,
        recovery_plan: recoveryPlan,
        next_step: installCommands[0],
        required_packages: ["typescript", "@vue/language-server"],
        install_example: installCommands[0],
        notes: [
          "Default behavior is strict to avoid hidden fallback confusion.",
          "Set LSP_MCP_VUE_STRICT_SEMANTIC=false to allow degraded fallback responses.",
        ],
      }),
    }],
  };
}

function buildVueDiagnosticsFallback(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  const limit = typeof args.preview_limit === "number" ? args.preview_limit : 200;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        count: 0,
        summary: { by_severity: {}, by_file: {} },
        preview: { shown: 0, limit, truncated: false },
        diagnostics: [],
        fallback: "vue_semantic_unavailable",
        next: null,
      }),
    }],
  };
}

function resolveWorkspaceForLock(fileOrPath?: string | null): string | null {
  const candidate = fileOrPath || activeWorkspacePath;
  if (!candidate) return null;
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    return path.dirname(resolved);
  }
  const stat = fs.statSync(resolved);
  return stat.isDirectory() ? resolved : path.dirname(resolved);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function updateOwnedLockMetadata(): void {
  for (const lockPath of backendSingletonLocks.values()) {
    try {
      if (!fs.existsSync(lockPath)) continue;
      const raw = fs.readFileSync(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload?.pid !== process.pid) continue;
      const nextPayload = {
        ...payload,
        rpc_host: singletonRpcEndpoint?.host ?? null,
        rpc_port: singletonRpcEndpoint?.port ?? null,
      };
      fs.writeFileSync(lockPath, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf-8");
    } catch {
      // Best-effort metadata refresh.
    }
  }
}

function ensureSingletonRpcServer(): { host: string; port: number } | null {
  if (singletonRpcEndpoint && singletonRpcServer) return singletonRpcEndpoint;
  if (singletonRpcStarting) return singletonRpcEndpoint;
  singletonRpcStarting = true;
  try {
    fs.mkdirSync(BACKEND_LOCK_DIR, { recursive: true });

    const server = net.createServer((socket) => {
      socket.setEncoding("utf-8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            handleSingletonRpcLine(line)
              .then((reply) => socket.write(`${JSON.stringify(reply)}\n`))
              .catch((error) => socket.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`));
          }
          idx = buffer.indexOf("\n");
        }
      });
    });
    server.on("error", () => {
      // Disable RPC server for this process if socket cannot be established.
      singletonRpcServer = null;
      singletonRpcEndpoint = null;
      singletonRpcStarting = false;
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        singletonRpcEndpoint = { host: "127.0.0.1", port: addr.port };
        updateOwnedLockMetadata();
      }
      singletonRpcStarting = false;
    });
    singletonRpcServer = server;
    return singletonRpcEndpoint;
  } catch {
    singletonRpcStarting = false;
    return null;
  }
}

async function handleSingletonRpcLine(line: string): Promise<any> {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, error: "Invalid RPC payload" };
  }
  if (req?.action !== "call_tool") {
    return { ok: false, error: "Unsupported RPC action" };
  }
  const language = String(req.language || "");
  const tool = String(req.tool || "");
  const args = (req.args && typeof req.args === "object") ? req.args as Record<string, unknown> : {};
  const workspace = typeof req.workspace === "string" ? req.workspace : null;
  if (!language || !tool) {
    return { ok: false, error: "Missing language/tool in RPC request" };
  }

  try {
    if (!startedBackends.has(language)) {
      await backendManager.getBackend(language);
      startedBackends.add(language);
    }
    if (workspace) {
      try {
        await backendManager.callTool(language, "switch_workspace", { path: workspace });
      } catch {
        // Best-effort workspace sync for shared backend calls.
      }
    }
    const result = await backendManager.callTool(language, tool, args);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function callRemoteBackendTool(
  host: string,
  port: number,
  language: string,
  tool: string,
  args: Record<string, unknown>,
  workspace?: string | null
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tryOnce = (): Promise<{ content: Array<{ type: "text"; text: string }> }> => new Promise((resolve, reject) => {
    const client = net.createConnection(port, host);
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`RPC call timeout for ${language}.${tool}`));
    }, 15000);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    client.setEncoding("utf-8");
    client.on("connect", () => {
      client.write(`${JSON.stringify({ action: "call_tool", language, tool, args, workspace })}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      done(() => {
        try {
          const parsed = JSON.parse(line);
          if (!parsed?.ok) {
            reject(new Error(parsed?.error || `Remote ${language}.${tool} failed`));
            return;
          }
          resolve(parsed.result as { content: Array<{ type: "text"; text: string }> });
        } catch (error) {
          reject(error);
        } finally {
          client.end();
        }
      });
    });
    client.on("error", (error) => done(() => reject(error)));
  });
  let lastError: unknown = null;
  for (let i = 0; i < 6; i++) {
    try {
      return await tryOnce();
    } catch (error) {
      lastError = error;
      const message = String(error);
      const retryable = message.includes("ENOENT") || message.includes("ECONNREFUSED");
      if (!retryable || i === 5) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function releaseBackendSingletonLocks(): void {
  for (const [key, lockPath] of backendSingletonLocks.entries()) {
    try {
      if (!fs.existsSync(lockPath)) {
        backendSingletonLocks.delete(key);
        continue;
      }
      const raw = fs.readFileSync(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload?.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Best-effort cleanup.
    } finally {
      backendSingletonLocks.delete(key);
    }
  }
}

function shutdownSingletonRpcServer(): void {
  if (!singletonRpcServer) return;
  singletonRpcServer.close();
  singletonRpcServer = null;
  singletonRpcEndpoint = null;
  singletonRpcStarting = false;
}

type SingletonGuardResult =
  | { ok: true; proxyHost?: string; proxyPort?: number; ownerPid?: number }
  | { ok: false; response: { content: Array<{ type: "text"; text: string }> } };

async function ensureBackendSingleton(
  language: string,
  workspacePath?: string | null
): Promise<SingletonGuardResult> {
  if (!SINGLETON_BACKEND_ENABLED) return { ok: true };
  const workspace = resolveWorkspaceForLock(workspacePath);
  if (!workspace) return { ok: true };

  const key = `${language}:${workspace}`;
  if (backendSingletonLocks.has(key)) {
    return { ok: true };
  }

  try {
    fs.mkdirSync(BACKEND_LOCK_DIR, { recursive: true });
  } catch {
    // If lock directory cannot be created, avoid blocking functionality.
    return { ok: true };
  }

  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const lockPath = path.join(BACKEND_LOCK_DIR, `${hash}.json`);
  const rpcEndpoint = ensureSingletonRpcServer();
  const payload = {
    pid: process.pid,
    language,
    workspace,
    rpc_host: rpcEndpoint?.host ?? null,
    rpc_port: rpcEndpoint?.port ?? null,
    created_at: new Date().toISOString(),
  };

  const tryClaim = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      fs.closeSync(fd);
      backendSingletonLocks.set(key, lockPath);
      return true;
    } catch (error) {
      const message = String(error);
      if (!message.includes("EEXIST")) return false;
      return false;
    }
  };

  if (tryClaim()) return { ok: true };

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      const owner = JSON.parse(raw);
      if (owner?.pid === process.pid) {
        backendSingletonLocks.set(key, lockPath);
        return { ok: true };
      }
      if (!isProcessAlive(Number(owner?.pid))) {
        fs.unlinkSync(lockPath);
        if (tryClaim()) return { ok: true };
      } else if (SINGLETON_BACKEND_PROXY_ENABLED) {
        for (let i = 0; i < 6; i++) {
          try {
            const latestRaw = fs.readFileSync(lockPath, "utf-8");
            const latest = JSON.parse(latestRaw);
            if (
              typeof latest?.rpc_host === "string" &&
              Number.isFinite(Number(latest?.rpc_port)) &&
              Number(latest.rpc_port) > 0
            ) {
              return {
                ok: true,
                proxyHost: latest.rpc_host,
                proxyPort: Number(latest.rpc_port),
                ownerPid: Number(latest.pid) || undefined,
              };
            }
          } catch {
            // keep waiting
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (
        SINGLETON_BACKEND_PROXY_ENABLED &&
        typeof owner?.rpc_host === "string" &&
        Number.isFinite(Number(owner?.rpc_port)) &&
        Number(owner.rpc_port) > 0
      ) {
        return {
          ok: true,
          proxyHost: owner.rpc_host,
          proxyPort: Number(owner.rpc_port),
          ownerPid: Number(owner.pid) || undefined,
        };
      } else {
        return {
          ok: false,
          response: {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Backend singleton lock is already held for ${language} in this workspace.`,
                code: "BACKEND_SINGLETON_LOCKED",
                language,
                workspace,
                owner_pid: owner.pid,
                lock_path: lockPath,
                hint: "Close the other CLI session, or set LSP_MCP_SINGLETON_BACKEND_PROXY=true to forward calls.",
              }),
            }],
          },
        };
      }
    } catch {
      // If lock file is corrupted, overwrite it as stale.
      try {
        fs.unlinkSync(lockPath);
        if (tryClaim()) return { ok: true };
      } catch {
        // fallthrough
      }
    }
  }

  if (backendSingletonLocks.has(key)) return { ok: true };
  return {
    ok: false,
    response: {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: `Unable to acquire backend singleton lock for ${language}.`,
          code: "BACKEND_SINGLETON_LOCK_FAILED",
          language,
          workspace,
          lock_path: lockPath,
        }),
      }],
    },
  };
}

function isVueFragileToolName(toolName: string): boolean {
  return toolName === "symbols" || toolName === "hover" || toolName === "definition" || toolName === "references";
}

function isVueSemanticToolName(toolName: string): boolean {
  return toolName === "hover" || toolName === "definition" || toolName === "references" || toolName === "diagnostics";
}

function pickVueFallbackIdentifier(vueContent: string, args: Record<string, unknown>): string | null {
  const direct = extractIdentifierAtPosition(vueContent, Number(args.line), Number(args.column));
  if (direct) return direct;

  if (typeof args.query === "string" && args.query.trim().length > 0) {
    return args.query.trim();
  }

  const firstSymbol = buildVueFallbackSymbols(vueContent)[0];
  return firstSymbol?.name ?? null;
}

function buildVueFallbackResponse(
  toolName: string,
  filePathArg: string,
  args: Record<string, unknown>,
  activeWorkspacePath?: string
): { content: Array<{ type: "text"; text: string }> } | null {
  let absVuePath = filePathArg;
  if (!path.isAbsolute(absVuePath) && activeWorkspacePath) {
    absVuePath = path.join(activeWorkspacePath, absVuePath);
  }
  if (!absVuePath || !fs.existsSync(absVuePath)) return null;

  const vueContent = fs.readFileSync(absVuePath, "utf-8");
  if (toolName === "symbols") {
    const fallbackSymbols = buildVueFallbackSymbols(vueContent, typeof args.query === "string" ? args.query : undefined);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ symbols: fallbackSymbols, count: fallbackSymbols.length, fallback: "vue_regex" }),
      }],
    };
  }

  if (toolName === "hover") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let definitionNote = "";
    const localDecl = findDeclarationInFile(vueContent, escaped);
    if (localDecl) {
      definitionNote = `Fallback definition candidate: ${absVuePath}:${localDecl.line}:${localDecl.column}.`;
    } else {
      const workspaceHits = findWorkspaceIdentifierHits(ident, activeWorkspacePath);
      const declarationFileFirst = workspaceHits.sort((a, b) => Number(!a.file.endsWith(".d.ts")) - Number(!b.file.endsWith(".d.ts")));
      for (const hit of declarationFileFirst) {
        if (!fs.existsSync(hit.file)) continue;
        const fileContent = fs.readFileSync(hit.file, "utf-8");
        const decl = findDeclarationInFile(fileContent, escaped);
        if (!decl) continue;
        definitionNote = `Fallback definition candidate: ${hit.file}:${decl.line}:${decl.column}.`;
        break;
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          contents: `symbol ${ident}`,
          documentation: definitionNote || "Fallback hover for Vue file (semantic server returned no info).",
          fallback: "vue_identifier",
        }),
      }],
    };
  }

  if (toolName === "definition") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const localDecl = findDeclarationInFile(vueContent, escaped);
    if (localDecl) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: absVuePath,
            line: localDecl.line,
            column: localDecl.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }

    const workspaceHits = findWorkspaceIdentifierHits(ident, activeWorkspacePath);
    const declarationFileFirst = workspaceHits.sort((a, b) => Number(!a.file.endsWith(".d.ts")) - Number(!b.file.endsWith(".d.ts")));
    for (const hit of declarationFileFirst) {
      if (!fs.existsSync(hit.file)) continue;
      const fileContent = fs.readFileSync(hit.file, "utf-8");
      const decl = findDeclarationInFile(fileContent, escaped);
      if (!decl) continue;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: hit.file,
            line: decl.line,
            column: decl.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }
    if (workspaceHits.length > 0) {
      const first = workspaceHits[0];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file: first.file,
            line: first.line,
            column: first.column,
            kind: "fallback",
            name: ident,
          }),
        }],
      };
    }
  }

  if (toolName === "references") {
    const ident = pickVueFallbackIdentifier(vueContent, args);
    if (!ident) return null;
    const refs = findWorkspaceIdentifierHits(ident, activeWorkspacePath).map((h) => ({
      file: h.file,
      line: h.line,
      column: h.column,
    }));
    if (refs.length === 0) {
      const localPattern = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      const lines = vueContent.split("\n");
      for (let i = 0; i < lines.length; i++) {
        localPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = localPattern.exec(lines[i])) !== null) {
          refs.push({ file: absVuePath, line: i + 1, column: match.index + 1 });
        }
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ references: refs, count: refs.length, fallback: "vue_regex" }),
      }],
    };
  }

  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function cleanupCursors(): void {
  const now = Date.now();
  for (const [key, value] of cursorStore.entries()) {
    if (now >= value.expiresAt || now - value.createdAt > CURSOR_TTL_MS) {
      cursorStore.delete(key);
    }
  }

  if (cursorStore.size > CURSOR_MAX_ENTRIES) {
    const sorted = Array.from(cursorStore.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const over = cursorStore.size - CURSOR_MAX_ENTRIES;
    for (let i = 0; i < over; i++) {
      cursorStore.delete(sorted[i][0]);
    }
  }
}

function signCursorBase(base: string): string {
  return createHash("sha256").update(`${base}:${CURSOR_SECRET}`).digest("hex").slice(0, 12);
}

function parseCursor(cursor: string): { baseCursor: string; offset: number; valid: boolean } {
  const offsetMatch = /:o(\d+)$/.exec(cursor);
  const offset = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
  const baseCursor = cursor.replace(/:o\d+$/, ":o0");
  const sigMatch = /:s([a-f0-9]{12}):o0$/.exec(baseCursor);
  if (!sigMatch) {
    return { baseCursor, offset, valid: false };
  }
  const signedPart = baseCursor.replace(/:s[a-f0-9]{12}:o0$/, "");
  const expected = signCursorBase(signedPart);
  return { baseCursor, offset, valid: expected === sigMatch[1] };
}

function makeCursor(tool: string, items: any[], count?: number, summary?: any): string {
  cleanupCursors();
  const createdAt = Date.now();
  const unsignedBase = `${tool}:${createdAt.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  const sig = signCursorBase(unsignedBase);
  const token = `${unsignedBase}:s${sig}:o0`;
  cursorStore.set(token, {
    tool,
    items,
    createdAt,
    expiresAt: createdAt + CURSOR_TTL_MS,
    count,
    summary,
  });
  return token;
}

function readCursorPage(tool: string, cursor: string, pageSize: number): { ok: true; data: any } | { ok: false; data: any } {
  cleanupCursors();
  const parsed = parseCursor(cursor);
  if (!parsed.valid) {
    return { ok: false, data: { error: "Invalid cursor signature" } };
  }
  const baseCursor = parsed.baseCursor;
  const entry = cursorStore.get(baseCursor);
  if (!entry || entry.tool !== tool) {
    return { ok: false, data: { error: "Invalid or expired cursor" } };
  }
  if (Date.now() >= entry.expiresAt) {
    cursorStore.delete(baseCursor);
    return { ok: false, data: { error: "Cursor expired", expires_at: entry.expiresAt } };
  }

  const offset = parsed.offset;
  const pageItems = entry.items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < entry.items.length;

  return {
    ok: true,
    data: {
      items: pageItems,
      count: entry.count ?? entry.items.length,
      summary: entry.summary,
      page: {
        shown: pageItems.length,
        offset,
        page_size: pageSize,
        has_more: hasMore,
        next_cursor: hasMore ? `${baseCursor.replace(/:o0$/, "")}:o${nextOffset}` : null,
        expires_at: entry.expiresAt,
      },
    },
  };
}

function readCursorPageAny(cursor: string, pageSize: number): { ok: true; tool: string; data: any } | { ok: false; data: any } {
  cleanupCursors();
  const parsed = parseCursor(cursor);
  if (!parsed.valid) {
    return { ok: false, data: { error: "Invalid cursor signature" } };
  }
  const baseCursor = parsed.baseCursor;
  const entry = cursorStore.get(baseCursor);
  if (!entry) {
    return { ok: false, data: { error: "Invalid or expired cursor" } };
  }
  const page = readCursorPage(entry.tool, cursor, pageSize);
  if (!page.ok) {
    return page;
  }
  return { ok: true, tool: entry.tool, data: page.data };
}

/**
 * Language-specific tools that are not part of the unified set.
 * These will be registered with a prefix (e.g., python_move).
 */
const LANGUAGE_SPECIFIC_TOOLS: Record<Language, Array<{ 
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
}>> = {
  python: [
    { name: "move", description: "Move a function or class to another module", schema: { file: z.string(), line: z.number().int(), column: z.number().int(), destination: z.string() } },
    { name: "change_signature", description: "Change the signature of a function", schema: { file: z.string(), line: z.number().int(), column: z.number().int(), new_params: z.array(z.string()).optional() } },
    { name: "function_signature", description: "Get current signature of a function", schema: { file: z.string(), line: z.number().int(), column: z.number().int() } },
  ],
  typescript: [
    { name: "move", description: "Move a function, class, or variable to a new file", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(), destination: z.string().optional(), preview: z.boolean().default(false).optional() } },
    { name: "function_signature", description: "Get current signature of a function", schema: { file: z.string(), line: z.number().int().positive(), column: z.number().int().positive() } },
  ],
  vue: [],
};

/**
 * Backward-compatible namespaced aliases for unified tools.
 * Example: python_hover -> hover
 */
const LEGACY_NAMESPACED_UNIFIED_TOOL_NAMES = new Set([
  "hover",
  "definition",
  "implementation",
  "type_definition",
  "call_hierarchy",
  "type_hierarchy",
  "document_highlight",
  "code_lens",
  "selection_range",
  "folding_range",
  "document_link",
  "linked_editing_range",
  "semantic_tokens",
  "moniker",
  "inlay_hint_resolve",
  "references",
  "completions",
  "diagnostics",
  "symbols",
  "rename",
  "prepare_rename",
  "search",
  "signature_help",
  "update_document",
]);

// ============================================================================ 
// Global Workspace Tool
// ============================================================================ 

server.registerTool(
  "switch_workspace",
  {
    description: "Switch the global workspace root. Use switch_workspace_for_language for semantic language mappings in mixed-language repos.",
    inputSchema: {
      path: z.string().describe("Absolute path to the new project root directory"),
      apply_to_languages: z.boolean().default(false).optional().describe("Also apply this path to all enabled language workspaces (legacy compatibility)"),
    },
  },
  async ({ path: workspacePath, apply_to_languages }) => {
    activeWorkspacePath = workspacePath;
    const applyToLanguages = apply_to_languages === true;
    const results: Record<string, any> = {};
    
    // Get all enabled languages
    const languages = Object.keys(config.languages).filter(
      (lang) => config.languages[lang].enabled
    );

    if (applyToLanguages) {
      for (const lang of languages) {
        activeWorkspaceByLanguage.set(lang as Language, workspacePath);
      }
    }

    await Promise.all(
      languages.map(async (lang) => {
        try {
          // Only call if backend is already started
          if (startedBackends.has(lang) && applyToLanguages) {
            const result = await backendManager.callTool(lang, "switch_workspace", { path: workspacePath });
            results[lang] = JSON.parse(result.content[0].text);
          } else if (startedBackends.has(lang) && !applyToLanguages) {
            results[lang] = { status: "unchanged", message: "Language workspace unchanged; set with switch_workspace_for_language." };
          } else {
            results[lang] = { status: "not_started", message: "Workspace will be set when backend starts" };
          }
        } catch (error) {
          results[lang] = { error: String(error) };
        }
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            workspace: workspacePath,
            apply_to_languages: applyToLanguages,
            workspace_overrides: {
              python: getWorkspaceOverride("python"),
              typescript: getWorkspaceOverride("typescript"),
              vue: getWorkspaceOverride("vue"),
            },
            results,
          }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "switch_workspace_for_language",
  {
    description: "Switch workspace for one language backend only. Useful when a monorepo has separate per-language project roots.",
    inputSchema: {
      language: z.enum(["python", "typescript", "vue"]).describe("Language backend to update"),
      path: z.string().describe("Absolute path to the project root for this language"),
    },
  },
  async ({ language, path: workspacePath }) => {
    const lang = language as Language;
    activeWorkspaceByLanguage.set(lang, workspacePath);
    let result: Record<string, unknown>;
    try {
      if (startedBackends.has(lang)) {
        const forwarded = await backendManager.callTool(lang, "switch_workspace", { path: workspacePath });
        result = JSON.parse(forwarded.content[0].text);
      } else {
        result = { status: "not_started", message: "Workspace will be set when backend starts" };
      }
    } catch (error) {
      result = { error: String(error) };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          language: lang,
          workspace: workspacePath,
          global_workspace: activeWorkspacePath,
          result,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "discover_language_workspaces",
  {
    description: "Discover likely per-language project roots under a monorepo root and optionally apply them.",
    inputSchema: {
      root: z.string().optional().describe("Absolute root directory to scan. Defaults to global workspace if set."),
      max_depth: z.number().int().min(0).max(4).default(2).optional().describe("Directory scan depth (default: 2)."),
      apply: z.boolean().default(false).optional().describe("Whether to apply discovered mappings to this session."),
    },
  },
  async ({ root, max_depth, apply }) => {
    const scanRoot = root || activeWorkspacePath;
    if (!scanRoot) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "MISSING_SCAN_ROOT",
            message: "Provide root=... or set global workspace first.",
            next_step: "Call switch_workspace(path='/abs/root') or discover_language_workspaces(root='/abs/root').",
          }),
        }],
      };
    }
    if (!path.isAbsolute(scanRoot)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "ROOT_MUST_BE_ABSOLUTE",
            root: scanRoot,
          }),
        }],
      };
    }
    if (!fileExistsSafe(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "ROOT_NOT_FOUND",
            root: scanRoot,
          }),
        }],
      };
    }

    const depth = typeof max_depth === "number" ? max_depth : 2;
    const candidates = discoverWorkspaceCandidates(scanRoot, depth);

    const picked: Record<Language, WorkspaceCandidate | null> = {
      python: pickLanguageWorkspace("python", candidates, scanRoot),
      typescript: pickLanguageWorkspace("typescript", candidates, scanRoot),
      vue: pickLanguageWorkspace("vue", candidates, scanRoot),
    };
    const suggestions: Record<Language, string | null> = {
      python: picked.python?.dir || null,
      typescript: picked.typescript?.dir || null,
      vue: picked.vue?.dir || null,
    };

    const applied: Record<string, unknown> = {};
    if (apply) {
      for (const language of Object.keys(suggestions) as Language[]) {
        const langRoot = suggestions[language];
        if (!langRoot) continue;
        activeWorkspaceByLanguage.set(language, langRoot);
        if (startedBackends.has(language)) {
          try {
            const forwarded = await backendManager.callTool(language, "switch_workspace", { path: langRoot });
            applied[language] = JSON.parse(forwarded.content[0].text);
          } catch (error) {
            applied[language] = { error: String(error) };
          }
        } else {
          applied[language] = { status: "not_started", message: "Workspace set for next backend start" };
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          root: scanRoot,
          max_depth: depth,
          suggestions,
          candidates: candidates.map((c) => ({
            dir: c.dir,
            scores: {
              python: c.pythonScore,
              typescript: c.typescriptScore,
              vue: c.vueScore,
            },
            markers: {
              pyproject: c.hasPyproject,
              requirements: c.hasRequirements,
              package_json: c.hasPackageJson,
              tsconfig: c.hasTsconfig,
              vite_config: c.hasViteConfig,
              vue_dependency: c.hasVueDependency,
            },
          })),
          applied: apply ? applied : null,
          next_step: apply
            ? "Use status to verify workspaces.overrides and run semantic tools."
            : "Re-run with apply=true to set language workspaces in this session.",
        }),
      }],
    };
  }
);

/**
 * Pre-register all tools.
 * 1. Unified tools (hover, definition, etc.) with automatic routing.
 * 2. Language-specific tools with prefixes.
 */
function preRegisterTools(): void {
  // 1. Register Unified Tools
  for (const tool of UNIFIED_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: `${tool.description} (unified tool, routes automatically by file extension)`,
        inputSchema: tool.schema,
      },
      async (args) => {
        const hasExplicitPathArg = typeof args.path === "string";
        // --- Smart Parameter Correction (Fuzzy Logic) ---
        // Automatically fix out-of-bounds line/column numbers to prevent backend errors
        let paramWarning: string | undefined;
        if (typeof args.line === 'number' && typeof args.column === 'number') {
             const targetFile = (args.file as string) || (args.path as string);
             if (targetFile) {
                 let checkPath = targetFile;
                 if (!path.isAbsolute(checkPath) && activeWorkspacePath) {
                     checkPath = path.join(activeWorkspacePath, checkPath);
                 } else if (!path.isAbsolute(checkPath)) {
                     checkPath = path.resolve(checkPath);
                 }
                 
                 const fixed = validateAndFixPosition(checkPath, args.line, args.column);
                 if (fixed.warning) {
                     console.error(`[lsp-mcp] Auto-corrected params for ${tool.name}: ${fixed.warning}`);
                     args.line = fixed.line;
                     args.column = fixed.column;
                     paramWarning = `(Auto-corrected: ${fixed.warning})`;
                 }
             }
        }

        // --- Special Tool: Project Structure ---
        if (tool.name === "project_structure") {
             const targetPath = (args.path as string) || activeWorkspacePath || process.cwd();
             const maxDepth = typeof args.max_depth === "number" ? args.max_depth : 3;
             const maxEntries = typeof args.max_entries === "number" ? args.max_entries : 300;
             const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
             const { tree, shownEntries, truncated } = getProjectStructure(targetPath, maxDepth, maxEntries);
             const lines = tree.split("\n").filter(Boolean);

             if (typeof args.page_size === "number") {
               const cursor = makeCursor(tool.name, lines, lines.length, {
                 path: targetPath,
                 shown_entries: shownEntries,
                 truncated_preview: truncated,
               });
               const page = readCursorPage(tool.name, cursor, pageSize);
               if (!page.ok) {
                 return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
               }
               return {
                 content: [{
                   type: "text",
                   text: JSON.stringify({
                     lines: page.data.items,
                     count: lines.length,
                     summary: page.data.summary,
                     page: page.data.page,
                     next: page.data.page.has_more
                       ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                       : null,
                   }),
                 }],
               };
             }

             const tail = truncated
               ? `\n\n(Preview truncated at ${shownEntries} entries. Use 'path' on a subdirectory or increase 'max_entries' / 'max_depth' to expand.)`
               : `\n\n(Shown entries: ${shownEntries})`;
             return {
                 content: [{ type: "text", text: `Project Structure for ${targetPath}:\n\n${tree}${tail}` }]
             };
        }

        // --- Special Tool: Git Diagnostics ---
        if (tool.name === "git_diagnostics") {
             const cwd = activeWorkspacePath || process.cwd();
             const changedFiles = getGitChangedFiles(cwd);
             
             if (changedFiles.length === 0) {
                 return { content: [{ type: "text", text: "No changed files found in git." }] };
             }
             
             const results: string[] = [];
             const failedBackendStart = new Map<string, string>();
             
             // Group by language to batch start backends? No, just iterate.
             for (const file of changedFiles) {
                 const language = inferLanguageFromPath(file, config);
                 if (!language) continue; // Skip unsupported files

                 if (failedBackendStart.has(language)) {
                     results.push(`⚠️ ${path.basename(file)}: Skipped (${language} backend unavailable: ${failedBackendStart.get(language)})`);
                     continue;
                 }
                 
                 // Start backend if needed
                 if (!startedBackends.has(language)) {
                     try {
                         await backendManager.getBackend(language);
                         startedBackends.add(language);
                     } catch (e) {
                         const reason = e instanceof Error ? e.message : String(e);
                         failedBackendStart.set(language, reason);
                         results.push(`⚠️ ${path.basename(file)}: Could not check (${language} backend failed to start: ${reason})`);
                         continue;
                     }
                 }
                 
                 try {
                     const relativePath = path.relative(cwd, file);
                     const res = await backendManager.callTool(language, "diagnostics", { path: relativePath });
                     const parsed = JSON.parse(res.content[0].text);
                     
                     if (parsed.error) {
                         results.push(`⚠️ ${path.basename(file)}: Backend error: ${parsed.error}`);
                         continue;
                     }

                     let diagnostics = [];
                     if (Array.isArray(parsed)) diagnostics = parsed;
                     else if (parsed.diagnostics && Array.isArray(parsed.diagnostics)) diagnostics = parsed.diagnostics;
                     else {
                         console.error(`[lsp-mcp] Unexpected diagnostics format for ${file}:`, parsed);
                         results.push(`⚠️ ${path.basename(file)}: Unexpected response format`);
                         continue;
                     }
                     
                     // Format output
                     if (diagnostics.length === 0) {
                         results.push(`✅ ${path.basename(file)}: No errors`);
                     } else {
                         const errors = diagnostics.map((d: any) => `  - [Line ${d.range?.start?.line ?? d.line ?? '?'}] ${d.message}`).join('\n');
                         results.push(`❌ ${path.basename(file)}:\n${errors}`);
                     }
                 } catch (e) {
                     results.push(`⚠️ ${path.basename(file)}: Check failed (${e})`);
                 }
             }
             
             return { content: [{ type: "text", text: `Git Diagnostics Report:\n\n${results.join('\n\n')}` }] };
        }

        // Cursor paging for high-volume tools
        if (
          (tool.name === "search" ||
            tool.name === "workspace_symbol" ||
            tool.name === "diagnostics" ||
            tool.name === "references" ||
            tool.name === "project_structure" ||
            tool.name === "summarize_file" ||
            tool.name === "read_file_with_hints") &&
          typeof args.cursor === "string"
        ) {
          const pageSize = typeof args.page_size === "number"
            ? args.page_size
            : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
          const page = readCursorPage(tool.name, args.cursor, pageSize);
          if (!page.ok) {
            return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
          }

          const itemsKey =
            tool.name === "diagnostics"
              ? "diagnostics"
              : tool.name === "references"
                ? "references"
              : (tool.name === "search" || tool.name === "workspace_symbol")
                ? "matches"
                : "lines";
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                [itemsKey]: page.data.items,
                count: page.data.count,
                summary: page.data.summary,
                resolved_language:
                  tool.name === "search" || tool.name === "workspace_symbol" || tool.name === "references" || tool.name === "diagnostics"
                    ? (page.data.summary?.resolved_language ?? null)
                    : undefined,
                resolved_workspace:
                  tool.name === "search" || tool.name === "workspace_symbol" || tool.name === "references" || tool.name === "diagnostics"
                    ? (page.data.summary?.resolved_workspace ?? null)
                    : undefined,
                resolved_workspaces:
                  tool.name === "search" || tool.name === "workspace_symbol"
                    ? (page.data.summary?.resolved_workspaces ?? null)
                    : undefined,
                page: page.data.page,
                next: page.data.page.has_more
                  ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                  : null,
              }),
            }],
          };
        }

        // For search, if workspace is known, auto-bind path so it can use normal routed flow.
        if (tool.name === "search" && !args.path) {
          if (activeWorkspacePath && activeWorkspaceByLanguage.size === 0) {
            args.path = activeWorkspacePath;
          } else {
            const enabled = Object.keys(config.languages).filter((lang) => config.languages[lang]?.enabled);
            if (enabled.length === 1) {
              const onlyLangWorkspace = getWorkspaceForLanguage(enabled[0] as Language);
              if (onlyLangWorkspace) {
                args.path = onlyLangWorkspace;
              }
            }
          }
        }

        // Find the target path argument
        const filePath = (args.file as string) || (args.path as string);
        const resolvedPathArg = typeof filePath === "string"
          ? (path.isAbsolute(filePath)
            ? filePath
            : (activeWorkspacePath ? path.join(activeWorkspacePath, filePath) : path.resolve(filePath)))
          : null;
        const searchPathIsDirectory =
          (tool.name === "search" || tool.name === "workspace_symbol") &&
          !!resolvedPathArg &&
          fs.existsSync(resolvedPathArg) &&
          fs.statSync(resolvedPathArg).isDirectory();
        
        // Handle search without path (uses active workspace implicitly via backend logic)
        // Use active workspace inference to auto-start at least one backend for better OOB behavior
        if (
          (tool.name === "search" || tool.name === "workspace_symbol") &&
          (!filePath || (searchPathIsDirectory && hasExplicitPathArg))
        ) {
             const enabledLanguages = Object.keys(config.languages).filter(
               (lang) => config.languages[lang].enabled
             );
             const pageSize = typeof args.page_size === "number"
               ? args.page_size
               : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
             const backendArgs = { ...(args as Record<string, unknown>) };
             delete backendArgs.preview_limit;
             delete backendArgs.page_size;
             delete backendArgs.cursor;
             if (tool.name === "search" && typeof backendArgs.pattern !== "string") {
               const query = typeof args.query === "string" ? args.query.trim() : "";
               if (query.length > 0) {
                 backendArgs.pattern = query;
               }
             }
             const requestedWorkspacePath = typeof backendArgs.path === "string"
               ? (path.isAbsolute(backendArgs.path)
                 ? backendArgs.path
                 : (activeWorkspacePath ? path.join(activeWorkspacePath, backendArgs.path) : path.resolve(backendArgs.path)))
               : null;
             const workspaceQuery =
               tool.name === "workspace_symbol" && typeof args.query === "string" && args.query.trim().length > 0
                 ? args.query.trim()
                 : null;
             const startedEnabled = enabledLanguages.filter((lang) => startedBackends.has(lang));
             const lockByLanguage = new Map<string, Promise<SingletonGuardResult>>();
             const resolveWorkspaceForLanguage = (lang: string): string | null => {
               if (requestedWorkspacePath) return requestedWorkspacePath;
               return getWorkspaceForLanguage(lang) || activeWorkspacePath;
             };
             const resolvedWorkspaces = Object.fromEntries(
               enabledLanguages.map((lang) => [lang, resolveWorkspaceForLanguage(lang)])
             );
             const resolvedLanguage = enabledLanguages.length === 1 ? enabledLanguages[0] : "multi";
             const resolvedWorkspace =
               resolvedLanguage === "multi"
                 ? null
                 : resolveWorkspaceForLanguage(resolvedLanguage);
             const getSingletonLock = (lang: string): Promise<SingletonGuardResult> => {
               const existing = lockByLanguage.get(lang);
               if (existing) return existing;
               const next = ensureBackendSingleton(lang, resolveWorkspaceForLanguage(lang));
               lockByLanguage.set(lang, next);
               return next;
             };
             const callLanguageTool = async (
               lang: string,
               toolName: string,
               callArgs: Record<string, unknown>
             ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
               const lock = await getSingletonLock(lang);
               if (!lock.ok) {
                 throw new Error(`Singleton lock unavailable for ${lang}`);
               }
               const langWorkspace = resolveWorkspaceForLanguage(lang);
               const nextArgs = { ...callArgs };
               if ((toolName === "search" || toolName === "workspace_symbol") && typeof nextArgs.path !== "string" && langWorkspace) {
                 nextArgs.path = langWorkspace;
               }
               if (lock.proxyHost && lock.proxyPort) {
                 return callRemoteBackendTool(lock.proxyHost, lock.proxyPort, lang, toolName, nextArgs, langWorkspace);
               }
               return backendManager.callTool(lang, toolName, nextArgs);
             };
             const startAndSyncBackend = async (lang: string) => {
               const lock = await getSingletonLock(lang);
               if (!lock.ok) return false;
               if (lock.proxyHost && lock.proxyPort) return true;
               await backendManager.getBackend(lang);
               startedBackends.add(lang);
               const langWorkspace = resolveWorkspaceForLanguage(lang);
               if (langWorkspace) {
                 await backendManager.callTool(lang, "switch_workspace", { path: langWorkspace });
               }
               return true;
             };

             if (tool.name === "workspace_symbol") {
                 for (const lang of enabledLanguages) {
                   if (startedBackends.has(lang)) continue;
                   try {
                     await startAndSyncBackend(lang);
                   } catch {
                     // Best-effort startup across languages for mixed-language workspaces.
                   }
                 }
             } else if (startedEnabled.length === 0) {
                 const preferred = requestedWorkspacePath
                   ? inferLanguageFromPath(requestedWorkspacePath, config)
                   : null;
                 const fallback = enabledLanguages.length === 1 ? enabledLanguages[0] : null;
                 const candidate = preferred || fallback;

                 if (candidate) {
                    try {
                      await startAndSyncBackend(candidate);
                    } catch (e) {
                      // Fall through to graceful empty response below
                    }
                 }
             }

             const results = [];
             let totalCount = 0;
             for (const lang of enabledLanguages) {
                 const lock = await getSingletonLock(lang);
                 if (!lock.ok) continue;
                 if ((lock.proxyHost && lock.proxyPort) || startedBackends.has(lang)) {
                     try {
                         let parsed: any;
                         try {
                           const res = await callLanguageTool(lang, tool.name, backendArgs);
                           parsed = JSON.parse(res.content[0].text);
                         } catch {
                           if (!workspaceQuery) {
                             continue;
                           }
                           // Fallback for backends that don't support workspace_symbol.
                           const fallbackRes = await callLanguageTool(lang, "search", {
                             pattern: workspaceQuery,
                           });
                           parsed = JSON.parse(fallbackRes.content[0].text);
                         }

                         let items = extractSearchLikeItems(parsed);
                         if (items.length === 0 && workspaceQuery) {
                           // Some backends may return empty workspace symbols even with valid query.
                           const fallbackRes = await callLanguageTool(lang, "search", {
                             pattern: workspaceQuery,
                           });
                           const fallbackParsed = JSON.parse(fallbackRes.content[0].text);
                           items = extractSearchLikeItems(fallbackParsed);
                           parsed = fallbackParsed;
                         }

                         const parsedCount = extractSearchLikeCount(parsed, items);
                         totalCount += parsedCount;
                         
                         if (items.length > 0) {
                            // Tag them with language if not present
                            const remaining = Math.max(pageSize - results.length, 0);
                            if (remaining > 0) {
                              results.push(...items.slice(0, remaining).map((i: any) => ({ ...i, language: lang })));
                            }
                         }
                     } catch (e) {
                         // ignore
                     }
                 }
             }
             if (results.length === 0) {
                 return {
                   content: [{
                     type: "text",
                     text: JSON.stringify({
                       matches: [],
                       count: 0,
                       message: "No matches found. If this is your first query, call switch_workspace(path=...) or pass path=... to search.",
                       resolved_language: resolvedLanguage,
                       resolved_workspace: resolvedWorkspace,
                       resolved_workspaces: resolvedWorkspaces,
                     }),
                   }],
                 };
             }
             const cursor = makeCursor(tool.name, results, totalCount, {
               resolved_language: resolvedLanguage,
               resolved_workspace: resolvedWorkspace,
               resolved_workspaces: resolvedWorkspaces,
             });
             const page = readCursorPage(tool.name, cursor, pageSize);
             if (!page.ok) {
               return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
             }

             return {
               content: [{
                 type: "text",
                 text: JSON.stringify({
                   matches: page.data.items,
                   count: totalCount,
                   resolved_language: resolvedLanguage,
                   resolved_workspace: resolvedWorkspace,
                   resolved_workspaces: resolvedWorkspaces,
                   page: page.data.page,
                   next: page.data.page.has_more
                     ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                     : null,
                 }),
               }],
             };
        }

        if (!filePath) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Missing 'file' or 'path' argument required for unified routing" }) }],
          };
        }

        // Resolve path to absolute to help inference check file existence
        let absPath = filePath;
        if (!path.isAbsolute(filePath)) {
            if (activeWorkspacePath) {
                absPath = path.join(activeWorkspacePath, filePath);
            } else {
                absPath = path.resolve(filePath);
            }
        }

        // Infer language from path (now uses config)
        const language = inferLanguageFromPath(absPath, config);
        if (!language) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Unsupported File Type",
                  message: `Cannot determine language for file '${filePath}'. Check configuration for supported extensions.`, 
                })
              },
            ],
          };
        }

        const languageWorkspace = getWorkspaceForLanguage(language);
        const semanticTool = isSemanticTool(tool.name);
        if (semanticTool && !languageWorkspace) {
          return semanticWorkspaceRequiredResponse(language, tool.name);
        }
        const resolvedWorkspace = semanticTool ? languageWorkspace : (languageWorkspace || activeWorkspacePath);
        if (!path.isAbsolute(filePath) && resolvedWorkspace) {
          absPath = path.join(resolvedWorkspace, filePath);
        }

        const isVueFragileTool = language === "vue" && isVueFragileToolName(tool.name);
        const isVueSemanticTool = language === "vue" && isVueSemanticToolName(tool.name);
        const isVueFallbackCapableTool = language === "vue" && (isVueFragileToolName(tool.name) || tool.name === "diagnostics");
        const lockWorkspace = resolvedWorkspace || absPath;
        const singletonLock = await ensureBackendSingleton(language, lockWorkspace);
        if (!singletonLock.ok) {
          return withSemanticContext(singletonLock.response, tool.name, resolvedWorkspace, null, language);
        }
        const proxyHost = singletonLock.proxyHost;
        const proxyPort = singletonLock.proxyPort;
        const hasProxy = !!proxyHost && !!proxyPort;
        const backendInstanceId = () =>
          hasProxy
            ? `proxy:${language}@${proxyHost}:${proxyPort}`
            : (backendManager.getBackendIdentity(language)?.instanceId ?? null);
        const missingVueToolDeps = !hasProxy && isVueFallbackCapableTool && vueSemanticDepsMissing(lockWorkspace, absPath);
        const callBackendTool = (toolName: string, backendArgs: Record<string, unknown>) => {
          if (proxyHost && proxyPort) {
            return callRemoteBackendTool(proxyHost, proxyPort, language, toolName, backendArgs, resolvedWorkspace || lockWorkspace);
          }
          return backendManager.callTool(language, toolName, backendArgs);
        };

        // Auto-start backend if not started
        if (!hasProxy && !startedBackends.has(language) && !missingVueToolDeps) {
          console.error(`[lsp-mcp] Auto-starting ${language} backend for unified ${tool.name}...`);
          try {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            // Sync active workspace if set
            if (resolvedWorkspace) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${resolvedWorkspace}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: resolvedWorkspace });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          } catch (error) {
            const msg = String(error);
            let hint = "";
            if (msg.includes("ENOENT")) {
                if (language === "python") hint = "Make sure 'uv' (recommended) or 'python' is installed and in your PATH.";
                else hint = "Make sure 'node' and 'npm' are installed and in your PATH.";
            } else if (language === "python" && (msg.includes("Connection closed") || msg.includes("MCP error -32000"))) {
                hint = "Python backend failed before handshake. Run `uv run --directory dist/bundled/python python-lsp-mcp --help` once to install runtime deps, or ensure network access / UV cache is available.";
            } else {
                hint = "Check server logs for details. You may need to install the backend manually.";
            }
            
            return withSemanticContext({
              content: [{ type: "text", text: JSON.stringify({ 
                  error: `Failed to start ${language} backend`,
                  details: msg,
                  hint: hint
              }, null, 2) }],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        // Capability Check: check if the backend actually supports this tool
        // Special case for composite tools like summarize_file (they use other tools internally)
        if (
          !hasProxy &&
          !missingVueToolDeps &&
          tool.name !== "summarize_file" &&
          tool.name !== "read_file_with_hints" &&
          tool.name !== "peek_definition"
        ) {
          const availableTools = await backendManager.getTools(language);
          const supportsTool = availableTools.some(t => t.name === tool.name);

          if (!supportsTool) {
            return withSemanticContext({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: "NOT_IMPLEMENTED",
                    error_code: "NOT_IMPLEMENTED",
                    message: `The '${language}' backend does not support the '${tool.name}' feature yet.`,
                    next_step: `Use 'list_backends' or 'status' to inspect backend capabilities, then switch language/workspace or use an alternative tool.`,
                    install_commands: [],
                    missing_packages: [],
                    strict_mode: true,
                    available_tools: availableTools.map(t => t.name),
                  })
                },
              ],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        // Special case for summarize_file
        if (tool.name === "summarize_file") {
          try {
            // Call symbols tool to get the data
            const symbolsArgs = { ...(args as Record<string, unknown>) };
            delete symbolsArgs.max_symbols;
            const result = await callBackendTool("symbols", symbolsArgs);
            const parsed = JSON.parse(result.content[0].text);
            
            if (parsed.error) {
              return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
            }

            const symbols = parsed.symbols || [];
            const summary = formatSymbolsToMarkdown(symbols);
            const maxSymbols = typeof args.max_symbols === "number" ? args.max_symbols : 200;
            const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
            const lines = summary.split("\n").filter(Boolean);
            const truncated = lines.length > maxSymbols;
            const preview = truncated ? `${lines.slice(0, maxSymbols).join("\n")}\n` : summary;

            if (typeof args.page_size === "number") {
              const cursor = makeCursor(tool.name, lines, lines.length, {
                file: filePath,
                max_symbols: maxSymbols,
              });
              const page = readCursorPage(tool.name, cursor, pageSize);
              if (!page.ok) {
                return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    lines: page.data.items,
                    count: lines.length,
                    summary: page.data.summary,
                    page: page.data.page,
                    next: page.data.page.has_more
                      ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                      : null,
                  }),
                }],
              };
            }
            
            return {
              content: [{
                type: "text",
                text: truncated
                  ? `File Summary for ${filePath} (preview ${maxSymbols}/${lines.length} symbols):\n\n${preview}\n(Use max_symbols to expand.)`
                  : `File Summary for ${filePath}:\n\n${preview || "(No symbols found)"}`
              }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to summarize file: ${error}` }) }],
            };
          }
        }
        
        // Special case for peek_definition
        if (tool.name === "peek_definition") {
          try {
            // 1. Call definition tool
            const result = await callBackendTool("definition", args as Record<string, unknown>);
            const parsed = JSON.parse(result.content[0].text);
            
            if (parsed.error) {
               return withSemanticContext({ content: [{ type: "text", text: JSON.stringify(parsed) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            // Definition can be array or single object
            let locs = Array.isArray(parsed) ? parsed : [parsed];
            if (parsed.matches) locs = parsed.matches; // Handle standardized matches format
            
            if (!locs || locs.length === 0) {
                return withSemanticContext({ content: [{ type: "text", text: JSON.stringify({ message: "No definition found" }) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            // Take the first definition
            const def = locs[0];
            const defPath = def.file || def.uri; // Handle potential naming diffs
            
            if (!defPath) {
                 return withSemanticContext({ content: [{ type: "text", text: JSON.stringify({ error: "Invalid definition result", raw: parsed }) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            let defAbsPath = defPath;
            if (!path.isAbsolute(defPath) && resolvedWorkspace) {
                 defAbsPath = path.join(resolvedWorkspace, defPath);
            }
            
            if (!fs.existsSync(defAbsPath)) {
                 return withSemanticContext({ content: [{ type: "text", text: JSON.stringify({ error: `Definition file not found: ${defAbsPath}`, location: def }) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            // 2. Read file context
            const fileContent = fs.readFileSync(defAbsPath, 'utf-8');
            const lines = fileContent.split('\n');
            
            // LSP lines are 0-based or 1-based?
            // Usually internal LSP is 0-based, but our tools expose 1-based?
            // src/tools/meta.ts says "line: z.number().int().positive()" -> 1-based input.
            // But backends usually return standardized response.
            // Let's assume the result from definition() is consistent with input: 1-based.
            // If it returns raw LSP 0-based, we might be off by one.
            // Let's assume 1-based for user-facing strings, checking definition return...
            // If definition tool output mimics 'search', it has 'line'.
            
            // Let's assume 1-based target line for now, and clamp.
            const targetLine = def.line; 
            // 0-based index
            const lineIdx = targetLine - 1; 
            
            const CONTEXT_LINES = 10;
            const startIdx = Math.max(0, lineIdx - CONTEXT_LINES);
            const endIdx = Math.min(lines.length, lineIdx + CONTEXT_LINES + 1);
            
            const contextSnippet = lines.slice(startIdx, endIdx)
                .map((line, i) => {
                    const currentLineNum = startIdx + i + 1;
                    const marker = currentLineNum === targetLine ? " >" : "  ";
                    return `${marker} ${currentLineNum.toString().padEnd(4)} | ${line}`;
                })
                .join('\n');
                
            const responseText = `Definition found in ${defPath} at line ${targetLine}:\n\n` +
                                 "```" + (language === 'python' ? 'python' : 'typescript') + "\n" +
                                 contextSnippet + "\n" +
                                 "```";
                                 
            return withSemanticContext({
                content: [{ type: "text", text: responseText }]
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);

          } catch (error) {
            return withSemanticContext({
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to peek definition: ${error}` }) }],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        // Special case for read_file_with_hints
        if (tool.name === "read_file_with_hints") {
          try {
            // 1. Read file content (using fs)
            // Note: args.file might be relative, inferLanguageFromPath resolved it? 
            // No, inferLanguageFromPath just checked extension.
            // We need to resolve path first.
            // But we don't have resolveFilePath here (it's in backend).
            // However, we rely on backendManager.callTool to resolve it internally?
            // No, fs.readFileSync needs abs path.
            
            // We can't easily resolve path here without duplicating logic or exposing it from backend.
            // BUT: backendManager.callTool("inlay_hints") will verify path.
            // If we pass the raw 'file' arg to backend, it will resolve it and check workspace.
            // But we need to read the SAME file locally.
            
            // Workaround: We require absolute path or relative to cwd?
            // Actually, we can rely on activeWorkspacePath global if set.
            let absPath = filePath;
            if (!path.isAbsolute(filePath) && resolvedWorkspace) {
                absPath = path.join(resolvedWorkspace, filePath);
            }
            
            if (!fs.existsSync(absPath)) {
                 return withSemanticContext({ content: [{ type: "text", text: JSON.stringify({ error: `File not found: ${absPath}` }) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }
            
            const content = fs.readFileSync(absPath, "utf-8");

            // 2. Get hints from backend
            const hintsArgs = { ...(args as Record<string, unknown>) };
            delete hintsArgs.page_size;
            delete hintsArgs.cursor;
            let hints: any[] = [];
            try {
              const result = await callBackendTool("inlay_hints", hintsArgs);
              const parsed = JSON.parse(result.content[0].text);
              if (parsed?.error) {
                const errorText = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
                if (!isInlayHintUnsupportedError(errorText)) {
                  return withSemanticContext({ content: [{ type: "text", text: JSON.stringify(parsed) }] }, tool.name, resolvedWorkspace, backendInstanceId(), language);
                }
              } else {
                hints = Array.isArray(parsed?.hints) ? parsed.hints : [];
              }
            } catch (error) {
              const errorText = String(error);
              if (!isInlayHintUnsupportedError(errorText)) {
                return withSemanticContext({
                  content: [{ type: "text", text: JSON.stringify({ error: `Failed to read file with hints: ${error}` }) }],
                }, tool.name, resolvedWorkspace, backendInstanceId(), language);
              }
            }
            
            // 3. Apply hints
            const contentWithHints = applyInlayHints(content, hints, language);
            const pageSize = typeof args.page_size === "number" ? args.page_size : 200;
            const startLine = typeof args.start_line === "number" ? args.start_line : 1;
            const maxLines = typeof args.max_lines === "number" ? args.max_lines : 300;
            const allLines = contentWithHints.split("\n");

            if (typeof args.page_size === "number") {
              const numbered = allLines.map((line, idx) => `${String(idx + 1).padStart(5)} | ${line}`);
              const cursor = makeCursor(tool.name, numbered, numbered.length, {
                file: filePath,
                total_lines: allLines.length,
              });
              const page = readCursorPage(tool.name, cursor, pageSize);
              if (!page.ok) {
                return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
              }
              return withSemanticContext({
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    lines: page.data.items,
                    count: numbered.length,
                    summary: page.data.summary,
                    page: page.data.page,
                    next: page.data.page.has_more
                      ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                      : null,
                  }),
                }],
              }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            const startIdx = Math.max(0, startLine - 1);
            const endIdx = Math.min(allLines.length, startIdx + maxLines);
            const isPreview = startIdx > 0 || endIdx < allLines.length;

            if (!isPreview) {
              return withSemanticContext({
                content: [{
                  type: "text",
                  text: contentWithHints
                }]
              }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            const snippet = allLines
              .slice(startIdx, endIdx)
              .map((line, idx) => `${String(startIdx + idx + 1).padStart(5)} | ${line}`)
              .join("\n");
            
            return withSemanticContext({
              content: [{
                type: "text",
                text: `File preview for ${filePath} (lines ${startIdx + 1}-${endIdx} of ${allLines.length}):\n\n${snippet}\n\n(Use start_line/max_lines to expand.)`
              }]
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          } catch (error) {
            return withSemanticContext({
              content: [{ type: "text", text: JSON.stringify({ error: `Failed to read file with hints: ${error}` }) }],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        // Rename argument for specific backend mismatches if any
        const backendArgs = { ...args } as Record<string, unknown>;
        if (tool.name === "rename") {
          if (language === "python") {
            // Python backend uses 'new_name'
            backendArgs.new_name = args.newName || args.new_name;
          } else {
            // TS/Vue uses 'newName'
            backendArgs.newName = args.newName || args.new_name;
          }
        }
        if (tool.name === "search" || tool.name === "workspace_symbol") {
          if (tool.name === "search" && typeof backendArgs.pattern !== "string") {
            const query = typeof args.query === "string" ? args.query.trim() : "";
            if (query.length > 0) {
              backendArgs.pattern = query;
            }
          }
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }
        if (tool.name === "references") {
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }
        if (tool.name === "diagnostics") {
          delete backendArgs.preview_limit;
          delete backendArgs.page_size;
          delete backendArgs.cursor;
          delete backendArgs.summary_only;
        }
        if (tool.name === "project_structure" || tool.name === "summarize_file" || tool.name === "read_file_with_hints") {
          delete backendArgs.page_size;
          delete backendArgs.cursor;
        }

        // Call the actual backend tool
        if (missingVueToolDeps) {
          if (VUE_STRICT_SEMANTIC && isVueSemanticTool) {
            return withSemanticContext(buildVueMissingDepsErrorResponse(tool.name, resolvedWorkspace), tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
          if (tool.name === "diagnostics") {
            return withSemanticContext(buildVueDiagnosticsFallback(args as Record<string, unknown>), tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
          if (isVueFragileTool && typeof filePath === "string") {
            const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, resolvedWorkspace || undefined);
            if (fallback) {
              return withSemanticContext(fallback, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }
          }
          if (isVueSemanticTool) {
            return withSemanticContext(buildVueMissingDepsErrorResponse(tool.name, resolvedWorkspace), tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }
        let backendResult;
        try {
          const callPromise = callBackendTool(tool.name, backendArgs);
          backendResult = isVueFragileTool
            ? await withTimeout(callPromise, 1200, `Vue ${tool.name}`)
            : await callPromise;
        } catch (error) {
          if (isVueFragileTool && typeof filePath === "string") {
            const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, resolvedWorkspace || undefined);
            if (fallback) {
              return withSemanticContext(fallback, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }
          }
          throw error;
        }

        if (language === "vue" && (tool.name === "symbols" || tool.name === "hover" || tool.name === "definition" || tool.name === "references")) {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const hoverText = typeof parsed?.contents === "string" ? parsed.contents.trim() : "";
            const referenceItems = extractReferencesItems(parsed);
            const shouldFallback =
              (tool.name === "symbols" && (parsed?.error || !Array.isArray(parsed?.symbols) || parsed.symbols.length === 0)) ||
              (tool.name === "hover" && (!!parsed?.error || hoverText === "any" || /^const\\s+\\w+:\\s*any$/i.test(hoverText))) ||
              (tool.name === "definition" && !!parsed?.error) ||
              (tool.name === "references" && (!!parsed?.error || referenceItems.length === 0));
            if (shouldFallback && typeof filePath === "string") {
              const fallback = buildVueFallbackResponse(tool.name, filePath, backendArgs, resolvedWorkspace || undefined);
              if (fallback) {
                return withSemanticContext(fallback, tool.name, resolvedWorkspace, backendInstanceId(), language);
              }
            }
          } catch {
            // Keep original backend response if fallback parsing fails.
          }
        }

        // High-volume results get a compact preview by default.
        if (tool.name === "search" || tool.name === "workspace_symbol") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const items = Array.isArray(parsed)
              ? parsed
              : extractSearchLikeItems(parsed);
            const count = extractSearchLikeCount(parsed, items);
            const cursor = makeCursor(tool.name, items, count, {
              resolved_language: language,
              resolved_workspace: resolvedWorkspace,
            });
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  matches: page.data.items,
                  count,
                  resolved_language: language,
                  resolved_workspace: resolvedWorkspace,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            };
          } catch {
            return withSemanticContext(backendResult, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        if (tool.name === "references") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const items = extractReferencesItems(parsed);
            const count = extractReferencesCount(parsed, items);
            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const cursor = makeCursor(tool.name, items, count, {
              resolved_language: language,
              resolved_workspace: resolvedWorkspace,
            });
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return withSemanticContext({
              content: [{
                type: "text",
                text: JSON.stringify({
                  references: page.data.items,
                  count,
                  resolved_language: language,
                  resolved_workspace: resolvedWorkspace,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          } catch {
            return withSemanticContext(backendResult, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        if (tool.name === "diagnostics") {
          try {
            const parsed = JSON.parse(backendResult.content[0].text);
            const diagnostics = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed.diagnostics)
                ? parsed.diagnostics
                : null;
            if (!diagnostics) return withSemanticContext(backendResult, tool.name, resolvedWorkspace, backendInstanceId(), language);

            const pageSize = typeof args.page_size === "number"
              ? args.page_size
              : (typeof args.preview_limit === "number" ? args.preview_limit : 200);
            const summaryOnly = !!args.summary_only;

            const severityCounts = diagnostics.reduce((acc: Record<string, number>, d: any) => {
              const sev = String(d.severity ?? "unknown");
              acc[sev] = (acc[sev] || 0) + 1;
              return acc;
            }, {});
            const fileCounts = diagnostics.reduce((acc: Record<string, number>, d: any) => {
              const key = d.file || d.uri || args.path || "unknown";
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {});

            if (summaryOnly) {
              return withSemanticContext({
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    count: diagnostics.length,
                    resolved_language: language,
                    resolved_workspace: resolvedWorkspace,
                    summary: {
                      by_severity: severityCounts,
                      by_file: fileCounts,
                    },
                    preview: {
                      shown: 0,
                      limit: pageSize,
                      truncated: diagnostics.length > 0,
                    },
                    next: diagnostics.length > 0
                      ? { tool: tool.name, arguments: { path: args.path, summary_only: false, page_size: pageSize } }
                      : null,
                  }),
                }],
              }, tool.name, resolvedWorkspace, backendInstanceId(), language);
            }

            const summary = {
              resolved_language: language,
              resolved_workspace: resolvedWorkspace,
              by_severity: severityCounts,
              by_file: fileCounts,
            };
            const cursor = makeCursor(tool.name, diagnostics, diagnostics.length, summary);
            const page = readCursorPage(tool.name, cursor, pageSize);
            if (!page.ok) {
              return { content: [{ type: "text", text: JSON.stringify(page.data) }] };
            }
            return withSemanticContext({
              content: [{
                type: "text",
                text: JSON.stringify({
                  diagnostics: page.data.items,
                  count: diagnostics.length,
                  resolved_language: language,
                  resolved_workspace: resolvedWorkspace,
                  summary,
                  page: page.data.page,
                  next: page.data.page.has_more
                    ? { tool: "expand_result", arguments: { cursor: page.data.page.next_cursor, page_size: pageSize } }
                    : null,
                }),
              }],
            }, tool.name, resolvedWorkspace, backendInstanceId(), language);
          } catch {
            return withSemanticContext(backendResult, tool.name, resolvedWorkspace, backendInstanceId(), language);
          }
        }

        return withSemanticContext(backendResult, tool.name, resolvedWorkspace, backendInstanceId(), language);
      }
    );
    registeredTools.add(tool.name);
  }

  // 1.5 Register legacy namespaced aliases for common unified tools
  for (const [language, langConfig] of Object.entries(config.languages)) {
    if (!langConfig?.enabled) continue;

    for (const tool of UNIFIED_TOOLS) {
      if (!LEGACY_NAMESPACED_UNIFIED_TOOL_NAMES.has(tool.name)) continue;

      const aliasName = `${language}_${tool.name}`;
      if (registeredTools.has(aliasName)) continue;

      server.registerTool(
        aliasName,
        {
          description: `${tool.description} (legacy alias; prefer '${tool.name}')`,
          inputSchema: tool.schema,
        },
        async (args) => {
          const languageName = language as Language;
          const languageWorkspace = getWorkspaceForLanguage(languageName);
          if (isSemanticTool(tool.name) && !languageWorkspace) {
            return semanticWorkspaceRequiredResponse(languageName, tool.name);
          }
          const resolvedWorkspace = isSemanticTool(tool.name) ? languageWorkspace : (languageWorkspace || activeWorkspacePath);
          const lockWorkspace = resolvedWorkspace || (args.file as string) || (args.path as string) || null;
          const singletonLock = await ensureBackendSingleton(language, lockWorkspace);
          if (!singletonLock.ok) {
            return withSemanticContext(singletonLock.response, tool.name, resolvedWorkspace, null, languageName);
          }
          const proxyHost = singletonLock.proxyHost;
          const proxyPort = singletonLock.proxyPort;
          const hasProxy = !!proxyHost && !!proxyPort;
          const backendInstanceId = hasProxy
            ? `proxy:${languageName}@${proxyHost}:${proxyPort}`
            : (backendManager.getBackendIdentity(languageName)?.instanceId ?? null);

          if (!hasProxy && !startedBackends.has(language)) {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            if (resolvedWorkspace) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${resolvedWorkspace}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: resolvedWorkspace });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          }

          const backendArgs = { ...args } as Record<string, unknown>;
          if (tool.name === "rename") {
            if (language === "python") {
              backendArgs.new_name = args.newName || args.new_name;
            } else {
              backendArgs.newName = args.newName || args.new_name;
            }
          }

          if (proxyHost && proxyPort) {
            return withSemanticContext(
              await callRemoteBackendTool(proxyHost, proxyPort, language, tool.name, backendArgs, resolvedWorkspace || lockWorkspace),
              tool.name,
              resolvedWorkspace,
              backendInstanceId,
              languageName
            );
          }
          return withSemanticContext(
            await backendManager.callTool(languageName, tool.name, backendArgs),
            tool.name,
            resolvedWorkspace,
            backendInstanceId,
            languageName
          );
        }
      );

      registeredTools.add(aliasName);
    }
  }

  // 2. Register Language-Specific Tools
  // Iterate over configured languages
  for (const [language, langConfig] of Object.entries(config.languages)) {
    if (!langConfig?.enabled) continue;

    const tools = LANGUAGE_SPECIFIC_TOOLS[language];
    if (!tools) continue;

    for (const tool of tools) {
      const namespacedName = `${language}_${tool.name}`;
      server.registerTool(
        namespacedName,
        {
          description: tool.description,
          inputSchema: tool.schema,
        },
        async (args) => {
          const languageName = language as Language;
          const languageWorkspace = getWorkspaceForLanguage(languageName);
          if (isSemanticTool(tool.name) && !languageWorkspace) {
            return semanticWorkspaceRequiredResponse(languageName, tool.name);
          }
          const resolvedWorkspace = isSemanticTool(tool.name) ? languageWorkspace : (languageWorkspace || activeWorkspacePath);
          const lockWorkspace = resolvedWorkspace || (args.file as string) || (args.path as string) || null;
          const singletonLock = await ensureBackendSingleton(language, lockWorkspace);
          if (!singletonLock.ok) {
            return withSemanticContext(singletonLock.response, tool.name, resolvedWorkspace, null, languageName);
          }
          const proxyHost = singletonLock.proxyHost;
          const proxyPort = singletonLock.proxyPort;
          const hasProxy = !!proxyHost && !!proxyPort;
          const backendInstanceId = hasProxy
            ? `proxy:${languageName}@${proxyHost}:${proxyPort}`
            : (backendManager.getBackendIdentity(languageName)?.instanceId ?? null);

          if (!hasProxy && !startedBackends.has(language)) {
            await backendManager.getBackend(language);
            startedBackends.add(language);

            // Sync active workspace if set
            if (resolvedWorkspace) {
              console.error(`[lsp-mcp] Syncing active workspace to ${language}: ${resolvedWorkspace}`);
              try {
                await backendManager.callTool(language, "switch_workspace", { path: resolvedWorkspace });
              } catch (syncError) {
                console.error(`[lsp-mcp] Failed to sync workspace to ${language}:`, syncError);
              }
            }
          }
          if (proxyHost && proxyPort) {
            return withSemanticContext(
              await callRemoteBackendTool(proxyHost, proxyPort, language, tool.name, args as Record<string, unknown>, resolvedWorkspace || lockWorkspace),
              tool.name,
              resolvedWorkspace,
              backendInstanceId,
              languageName
            );
          }
          return withSemanticContext(
            await backendManager.callTool(languageName, tool.name, args as Record<string, unknown>),
            tool.name,
            resolvedWorkspace,
            backendInstanceId,
            languageName
          );
        }
      );
      registeredTools.add(namespacedName);
    }
  }

  console.error(`[lsp-mcp] Unified and language-specific tools registered`);
}

// Pre-register all tools
preRegisterTools();

// ============================================================================ 
// Graceful Shutdown
// ============================================================================ 

async function gracefulShutdown(signal: string): Promise<void> {
  console.error(`\n[lsp-mcp] Received ${signal}, shutting down gracefully...`);

  try {
    await backendManager.shutdown();
    await server.close();
    releaseBackendSingletonLocks();
    shutdownSingletonRpcServer();
    console.error("[lsp-mcp] Shutdown complete");
    process.exit(0);
  } catch (error) {
    releaseBackendSingletonLocks();
    shutdownSingletonRpcServer();
    console.error("[lsp-mcp] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("exit", () => {
  releaseBackendSingletonLocks();
  shutdownSingletonRpcServer();
});

// ============================================================================ 
// Main
// ============================================================================ 

async function main() {
  console.error("LSP MCP Server - Unified Multi-Language Code Intelligence");
  console.error(`  Version: ${packageJson.version}`);
  console.error("  Python:", config.languages.python?.enabled ? `enabled` : "disabled");
  console.error("  TypeScript:", config.languages.typescript?.enabled ? "enabled" : "disabled");
  console.error("  Vue:", config.languages.vue?.enabled ? "enabled" : "disabled");
  console.error("");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Eagerly start all enabled backends if configured
  if (config.eagerStart) {
    console.error("Eager start enabled - starting all backends now...");
    
    // Start backends in parallel
    const enabledLanguages = Object.keys(config.languages).filter(l => config.languages[l].enabled);
    await Promise.allSettled(
      enabledLanguages.map(async (lang) => {
        try {
          await backendManager.getBackend(lang);
          startedBackends.add(lang);
          console.error(`  ${lang}: backend started`);
        } catch (error) {
          console.error(`  ${lang}: failed to start - ${error}`);
        }
      })
    );
  } else {
    console.error("Tools are pre-registered. Backends start automatically on first use.");
  }

  console.error("");
  console.error("Ready");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
