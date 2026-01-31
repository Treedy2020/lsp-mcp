import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

/**
 * Configuration system for the unified LSP MCP server.
 *
 * Supports environment variables and programmatic configuration.
 */

export type Language = "python" | "typescript" | "vue";
export type PythonProvider = "python-lsp-mcp" | "pyright-mcp";

export interface BackendConfig {
  enabled: boolean;
  command: string;
  args: string[];
}

export interface Config {
  python: {
    enabled: boolean;
    provider: PythonProvider;
  };
  typescript: {
    enabled: boolean;
  };
  vue: {
    enabled: boolean;
  };
  autoUpdate: boolean; // If true, always fetch latest versions on startup
  eagerStart: boolean; // If true, start all backends at startup (makes tools available immediately)
}

/**
 * Load configuration from environment variables.
 */
export function loadConfig(): Config {
  const pythonEnabled = getEnvBool("LSP_MCP_PYTHON_ENABLED", true);
  const pythonProvider = getEnvString(
    "LSP_MCP_PYTHON_PROVIDER",
    "python-lsp-mcp"
  ) as PythonProvider;

  const typescriptEnabled = getEnvBool("LSP_MCP_TYPESCRIPT_ENABLED", true);
  const vueEnabled = getEnvBool("LSP_MCP_VUE_ENABLED", true);

  // Auto-update is enabled by default - always fetch latest versions
  const autoUpdate = getEnvBool("LSP_MCP_AUTO_UPDATE", true);

  // Eager start - if true, start all backends at startup
  // If false (default), backends are loaded on-demand via start_backend tool
  const eagerStart = getEnvBool("LSP_MCP_EAGER_START", false);

  return {
    python: {
      enabled: pythonEnabled,
      provider: pythonProvider,
    },
    typescript: {
      enabled: typescriptEnabled,
    },
    vue: {
      enabled: vueEnabled,
    },
    autoUpdate,
    eagerStart,
  };
}

/**
 * Get a boolean from an environment variable.
 */
function getEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Get a string from an environment variable.
 */
function getEnvString(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * File extension to language mapping.
 */
const EXTENSION_MAP: Record<string, Language> = {
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mts": "typescript",
  ".mjs": "typescript",
  ".cts": "typescript",
  ".cjs": "typescript",
  ".vue": "vue",
};

/**
 * Infer the language from a file path based on its extension.
 */
export function inferLanguageFromPath(filePath: string): Language | null {
  const ext = filePath.substring(filePath.lastIndexOf("."));
  return EXTENSION_MAP[ext] ?? null;
}

/**
 * Parse a namespaced tool name like "python/hover" into its components.
 */
export function parseToolName(
  toolName: string
): { language: Language; tool: string } | null {
  const parts = toolName.split("/");
  if (parts.length !== 2) return null;

  const [lang, tool] = parts;
  if (lang !== "python" && lang !== "typescript" && lang !== "vue") return null;

  return { language: lang as Language, tool };
}

/**
 * Resolve the path to a bundled backend.
 * Checks if dist/bundled/<name> exists relative to the current script.
 */
function resolveBundledBackend(name: string): string | null {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    // Check if we are in dist/ (production) or src/ (dev)
    const isInDist = currentDir.endsWith("dist") || currentDir.endsWith("dist/");
    
    // Construct path to bundled directory
    // If in dist/ (e.g. dist/index.js), bundled is in dist/bundled/
    // If in src/ (dev), bundled might not exist or we might want to use project root logic
    const bundledDir = isInDist 
      ? path.resolve(currentDir, "bundled", name)
      : path.resolve(currentDir, "..", "dist", "bundled", name);

    if (fs.existsSync(bundledDir)) {
      return bundledDir;
    }
  } catch (error) {
    // Ignore errors resolving path
  }
  return null;
}

/**
 * Get the backend command for a language.
 *
 * Priority:
 * 1. Bundled backend (dist/bundled/<name>)
 * 2. npm/uvx download (fallback)
 *
 * When autoUpdate is enabled:
 * - npx: Uses --yes flag to skip prompts (already uses @latest)
 * - uvx: Uses --upgrade flag to always fetch latest version
 */
export function getBackendCommand(
  language: Language,
  config: Config
): BackendConfig | null {
  const { autoUpdate } = config;

  if (language === "python") {
    if (!config.python.enabled) return null;

    if (config.python.provider === "pyright-mcp") {
      // Check for bundled pyright backend
      const bundledPath = resolveBundledBackend("pyright");
      if (bundledPath) {
        console.error(`[Config] Using bundled pyright backend from ${bundledPath}`);
        return {
          enabled: true,
          command: "node",
          args: [path.join(bundledPath, "dist", "index.js")],
        };
      }

      return {
        enabled: true,
        command: "npx",
        args: autoUpdate
          ? ["--yes", "@treedy/pyright-mcp@latest"]
          : ["@treedy/pyright-mcp@latest"],
      };
    } else {
      // python-lsp-mcp
      
      // Check for bundled python backend
      const bundledPath = resolveBundledBackend("python");
      if (bundledPath) {
        console.error(`[Config] Using bundled python backend from ${bundledPath}`);
        return {
          enabled: true,
          command: "uv",
          args: ["run", "--directory", bundledPath, "python-lsp-mcp"],
        };
      }

      // python-lsp-mcp via uvx
      return {
        enabled: true,
        command: "uvx",
        args: autoUpdate
          ? ["--upgrade", "python-lsp-mcp"]
          : ["python-lsp-mcp"],
      };
    }
  } else if (language === "typescript") {
    if (!config.typescript.enabled) return null;

    // Check for bundled typescript backend
    const bundledPath = resolveBundledBackend("typescript");
    if (bundledPath) {
      console.error(`[Config] Using bundled typescript backend from ${bundledPath}`);
      return {
        enabled: true,
        command: "node",
        args: [path.join(bundledPath, "dist", "index.js")],
      };
    }

    return {
      enabled: true,
      command: "npx",
      args: autoUpdate
        ? ["--yes", "@treedy/typescript-lsp-mcp@latest"]
        : ["@treedy/typescript-lsp-mcp@latest"],
    };
  } else if (language === "vue") {
    if (!config.vue.enabled) return null;

    // Check for bundled vue backend
    const bundledPath = resolveBundledBackend("vue");
    if (bundledPath) {
      console.error(`[Config] Using bundled vue backend from ${bundledPath}`);
      return {
        enabled: true,
        command: "node",
        args: [path.join(bundledPath, "dist", "index.js")],
      };
    }

    return {
      enabled: true,
      command: "npx",
      args: autoUpdate
        ? ["--yes", "@treedy/vue-lsp-mcp@latest"]
        : ["@treedy/vue-lsp-mcp@latest"],
    };
  }

  return null;
}
