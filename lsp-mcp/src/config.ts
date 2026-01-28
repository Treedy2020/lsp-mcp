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
 * Get the backend command for a language.
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
      return {
        enabled: true,
        command: "npx",
        args: autoUpdate
          ? ["--yes", "@treedy/pyright-mcp@latest"]
          : ["@treedy/pyright-mcp@latest"],
      };
    } else {
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

    return {
      enabled: true,
      command: "npx",
      args: autoUpdate
        ? ["--yes", "@treedy/typescript-lsp-mcp@latest"]
        : ["@treedy/typescript-lsp-mcp@latest"],
    };
  } else if (language === "vue") {
    if (!config.vue.enabled) return null;

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
