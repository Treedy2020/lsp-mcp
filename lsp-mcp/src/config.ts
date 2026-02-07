import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

/**
 * Configuration system for the unified LSP MCP server.
 *
 * Supports environment variables and programmatic configuration.
 */

export type Language = string;

export interface LanguageConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  extensions: string[];
  // For backward compatibility / complex logic (like bundled path resolution)
  // we might keep some logic in code, but expose overrides here.
  // Or we can use a factory function in the default config.
}

export interface BackendConfig {
  enabled: boolean;
  command: string;
  args: string[];
}

export interface Config {
  // Generic language configurations
  languages: Record<string, LanguageConfig>;
  
  // Legacy fields for backward compatibility (mapped to languages)
  python?: { enabled: boolean; provider: string };
  typescript?: { enabled: boolean };
  vue?: { enabled: boolean };

  autoUpdate: boolean;
  eagerStart: boolean;
  idleTimeout: number;
}

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";

/**
 * Configuration system for the unified LSP MCP server.
 *
 * Supports environment variables and programmatic configuration.
 */

export type Language = string;

export interface LanguageConfig {
  enabled: boolean;
  command?: string;
  args?: string[];
  extensions: string[];
  // Environment variables to set for this backend
  env?: Record<string, string>;
}

export interface BackendConfig {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Config {
  // Generic language configurations
  languages: Record<string, LanguageConfig>;
  
  // Legacy fields for backward compatibility
  python?: { enabled: boolean; provider: string };
  typescript?: { enabled: boolean };
  vue?: { enabled: boolean };

  autoUpdate: boolean;
  eagerStart: boolean;
  idleTimeout: number;
}

// Default extensions mapping
const DEFAULT_EXTENSIONS: Record<string, string[]> = {
  python: [".py", ".pyi", ".pyw"],
  typescript: [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"],
  vue: [".vue"],
};

const DEFAULT_CONFIG: Config = {
  languages: {
    python: {
      enabled: true,
      extensions: DEFAULT_EXTENSIONS.python,
    },
    typescript: {
      enabled: true,
      extensions: DEFAULT_EXTENSIONS.typescript,
    },
    vue: {
      enabled: true,
      extensions: DEFAULT_EXTENSIONS.vue,
    },
  },
  autoUpdate: true,
  eagerStart: false,
  idleTimeout: 600,
};

/**
 * Load configuration from file and environment variables.
 */
export function loadConfig(): Config {
  // 1. Load from config file
  const fileConfig = loadConfigFile();

  // 2. Load from environment variables
  const envConfig = loadEnvConfig();

  // 3. Merge: Env > File > Default
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    languages: {
      ...DEFAULT_CONFIG.languages,
      ...(fileConfig?.languages || {}),
      // Merge env config for languages carefully
      ...Object.keys(DEFAULT_CONFIG.languages).reduce((acc, lang) => {
        // If env has explicit setting, override
        if (envConfig.languages?.[lang]) {
            acc[lang] = {
                ...(fileConfig?.languages?.[lang] || DEFAULT_CONFIG.languages[lang]),
                ...envConfig.languages[lang]
            };
        }
        return acc;
      }, {} as Record<string, LanguageConfig>)
    }
  };

  // Ensure extensions are set if missing in file config
  for (const [lang, cfg] of Object.entries(merged.languages)) {
      if (cfg && !cfg.extensions && DEFAULT_EXTENSIONS[lang]) {
          cfg.extensions = DEFAULT_EXTENSIONS[lang];
      }
  }

  return merged;
}

function loadConfigFile(): Partial<Config> | null {
    const locations = [
        path.resolve(process.cwd(), ".lsp-mcp.json"),
        path.join(os.homedir(), ".config", "lsp-mcp", "config.json")
    ];
    
    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            try {
                console.error(`[Config] Loading configuration from ${loc}`);
                const content = fs.readFileSync(loc, "utf-8");
                return JSON.parse(content);
            } catch (e) {
                console.error(`[Config] Failed to parse config file ${loc}: ${e}`);
            }
        }
    }
    return null;
}

function loadEnvConfig(): Partial<Config> {
  const pythonEnabled = getEnvBool("LSP_MCP_PYTHON_ENABLED");
  const pythonProvider = getEnvString("LSP_MCP_PYTHON_PROVIDER");
  const typescriptEnabled = getEnvBool("LSP_MCP_TYPESCRIPT_ENABLED");
  const vueEnabled = getEnvBool("LSP_MCP_VUE_ENABLED");

  const autoUpdate = getEnvBool("LSP_MCP_AUTO_UPDATE");
  const eagerStart = getEnvBool("LSP_MCP_EAGER_START");
  const idleTimeoutStr = getEnvString("LSP_MCP_IDLE_TIMEOUT");
  const idleTimeout = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : undefined;

  const config: Partial<Config> = {};
  const languages: Record<string, Partial<LanguageConfig>> = {};

  if (pythonEnabled !== undefined) languages.python = { enabled: pythonEnabled };
  if (typescriptEnabled !== undefined) languages.typescript = { enabled: typescriptEnabled };
  if (vueEnabled !== undefined) languages.vue = { enabled: vueEnabled };

  if (Object.keys(languages).length > 0) config.languages = languages as any;
  if (autoUpdate !== undefined) config.autoUpdate = autoUpdate;
  if (eagerStart !== undefined) config.eagerStart = eagerStart;
  if (idleTimeout !== undefined) config.idleTimeout = idleTimeout;
  
  // Legacy support
  if (pythonEnabled !== undefined || pythonProvider) {
      config.python = { 
          enabled: pythonEnabled ?? true, 
          provider: pythonProvider ?? "python-lsp-mcp" 
      };
  }

  return config;
}

/**
 * Get a boolean from an environment variable. Returns undefined if not set.
 */
function getEnvBool(name: string, defaultValue?: boolean): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Get a string from an environment variable. Returns undefined if not set.
 */
function getEnvString(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

/**
 * Infer the language from a file path based on its extension or directory content.
 * Uses the provided configuration to look up extensions.
 */
export function inferLanguageFromPath(filePath: string, config: Config): Language | null {
  // 1. Check if it's a directory and infer from contents
  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // Strategy A: Check for explicit config files in the CURRENT directory
        if (config.languages.typescript?.enabled && (
            fs.existsSync(path.join(filePath, "tsconfig.json")) || 
            fs.existsSync(path.join(filePath, "package.json"))
        )) return "typescript";
        
        if (config.languages.python?.enabled && (
            fs.existsSync(path.join(filePath, "pyproject.toml")) || 
            fs.existsSync(path.join(filePath, "requirements.txt")) ||
            fs.existsSync(path.join(filePath, "setup.py")) ||
            fs.existsSync(path.join(filePath, "venv")) ||
            fs.existsSync(path.join(filePath, ".venv"))
        )) return "python";

        if (config.languages.vue?.enabled && (
            fs.existsSync(path.join(filePath, "vite.config.ts")) ||
            fs.existsSync(path.join(filePath, "vue.config.js"))
        )) return "vue";

        // Strategy B: Check for source files in the CURRENT directory (Heuristic)
        try {
            const entries = fs.readdirSync(filePath);
            for (const entry of entries) {
                if (entry.endsWith(".ts") && config.languages.typescript?.enabled) return "typescript";
                if (entry.endsWith(".py") && config.languages.python?.enabled) return "python";
                if (entry.endsWith(".vue") && config.languages.vue?.enabled) return "vue";
            }
        } catch { }

        // Strategy C: Walk up to find project root (Config files in PARENT directories)
        // This handles running diagnostics on a subdirectory like 'src/utils'
        let currentDir = path.dirname(filePath);
        for (let i = 0; i < 5; i++) {
            if (config.languages.typescript?.enabled && (
                fs.existsSync(path.join(currentDir, "tsconfig.json")) || 
                fs.existsSync(path.join(currentDir, "package.json"))
            )) return "typescript";
            
            if (config.languages.python?.enabled && (
                fs.existsSync(path.join(currentDir, "pyproject.toml")) || 
                fs.existsSync(path.join(currentDir, "requirements.txt")) ||
                fs.existsSync(path.join(currentDir, "setup.py"))
            )) return "python";
            
            const parent = path.dirname(currentDir);
            if (parent === currentDir) break; 
            currentDir = parent;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. Fallback to extension check
  const ext = filePath.substring(filePath.lastIndexOf("."));
  
  for (const [lang, langConfig] of Object.entries(config.languages)) {
    if (langConfig?.enabled && langConfig.extensions.includes(ext)) {
      return lang;
    }
  }
  
  return null;
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
  const requireBundledBackends =
    (process.env.LSP_MCP_REQUIRE_BUNDLED_BACKENDS ?? "false").toLowerCase() === "true";
  const langConfig = config.languages[language];
  if (!langConfig || !langConfig.enabled) return null;

  // If command is explicitly configured (e.g. via config file in future), use it
  if (langConfig.command) {
    return {
      enabled: true,
      command: langConfig.command,
      args: langConfig.args || [],
      env: langConfig.env,
    };
  }

  // Fallback to built-in logic for known languages
  const { autoUpdate } = config;

  if (language === "python") {
    // Legacy logic for Python provider switching
    const provider = config.python?.provider || "python-lsp-mcp";

    if (provider === "pyright-mcp") {
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
      if (requireBundledBackends) {
        throw new Error(
          "Bundled pyright backend not found. Run `bun run build:bundled` in lsp-mcp to produce dist/bundled/pyright."
        );
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
          args: ["run", "--quiet", "--directory", bundledPath, "python-lsp-mcp"],
          env: {
            UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(os.tmpdir(), "lsp-mcp-uv-cache"),
          },
        };
      }
      if (requireBundledBackends) {
        throw new Error(
          "Bundled python backend not found. Run `bun run build:bundled` in lsp-mcp to produce dist/bundled/python."
        );
      }

      // python-lsp-mcp via uvx
      return {
        enabled: true,
        command: "uvx",
        args: autoUpdate
          ? ["--quiet", "--upgrade", "python-lsp-mcp"]
          : ["--quiet", "python-lsp-mcp"],
      };
    }
  } else if (language === "typescript") {
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
    if (requireBundledBackends) {
      throw new Error(
        "Bundled typescript backend not found. Run `bun run build:bundled` in lsp-mcp to produce dist/bundled/typescript."
      );
    }

    return {
      enabled: true,
      command: "npx",
      args: autoUpdate
        ? ["--yes", "@treedy/typescript-lsp-mcp@latest"]
        : ["@treedy/typescript-lsp-mcp@latest"],
    };
  } else if (language === "vue") {
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
    if (requireBundledBackends) {
      throw new Error(
        "Bundled vue backend not found. Run `bun run build:bundled` in lsp-mcp to produce dist/bundled/vue."
      );
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
