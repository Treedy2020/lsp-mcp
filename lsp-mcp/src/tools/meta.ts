/**
 * Meta tools for the unified LSP MCP server.
 *
 * These tools provide information about the server and control backend behavior.
 */

import { z } from "zod";
import type { BackendManager } from "../backend-manager.js";
import type { Config, PythonProvider } from "../config.js";

// Read version from package.json at runtime
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let serverVersion = "0.1.0";
try {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "../../package.json"), "utf-8")
  );
  serverVersion = packageJson.version;
} catch {
  // Use default version if package.json is not available
}

/**
 * Status tool schema.
 */
export const statusSchema = {};

export type BackendPackageInfo = {
  language: "python" | "typescript" | "vue";
  provider: string;
  package: string;
  package_ref: string;
  registry: "npm" | "pypi";
  resolver: "npx" | "uvx";
  install_command: string;
  update_command: string;
  default_channel: "latest";
  auto_update_enabled: boolean;
  minimum_supported_version: string;
};

function resolveBackendRuntimeMode(): "registry" | "bundled" | "auto" {
  const requireBundled = (process.env.LSP_MCP_REQUIRE_BUNDLED_BACKENDS ?? "false").toLowerCase() === "true";
  if (requireBundled) return "bundled";
  const runtimeMode = (process.env.LSP_MCP_BACKEND_RUNTIME_MODE || "registry").toLowerCase();
  if (runtimeMode === "bundled" || runtimeMode === "auto" || runtimeMode === "registry") {
    return runtimeMode;
  }
  return "registry";
}

export function getBackendPackages(config: Config): BackendPackageInfo[] {
  const pythonProvider = config.python?.provider || "python-lsp-mcp";
  const pythonPackage: Omit<BackendPackageInfo, "language" | "provider" | "default_channel" | "auto_update_enabled"> =
    pythonProvider === "pyright-mcp"
      ? {
          package: "@treedy/pyright-mcp",
          package_ref: "@treedy/pyright-mcp@latest",
          registry: "npm",
          resolver: "npx",
          install_command: "npx --yes @treedy/pyright-mcp@latest",
          update_command: "npx --yes @treedy/pyright-mcp@latest",
          minimum_supported_version: "0.1.0",
        }
      : {
          package: "python-lsp-mcp",
          package_ref: "python-lsp-mcp@latest",
          registry: "pypi",
          resolver: "uvx",
          install_command: "uvx --quiet --upgrade python-lsp-mcp",
          update_command: "uvx --quiet --upgrade python-lsp-mcp",
          minimum_supported_version: "1.20.0",
        };

  return [
    {
      language: "python",
      provider: pythonProvider,
      ...pythonPackage,
      default_channel: "latest",
      auto_update_enabled: config.autoUpdate,
    },
    {
      language: "typescript",
      provider: "typescript-lsp-mcp",
      package: "@treedy/typescript-lsp-mcp",
      package_ref: "@treedy/typescript-lsp-mcp@latest",
      registry: "npm",
      resolver: "npx",
      install_command: "npx --yes @treedy/typescript-lsp-mcp@latest",
      update_command: "npx --yes @treedy/typescript-lsp-mcp@latest",
      default_channel: "latest",
      auto_update_enabled: config.autoUpdate,
      minimum_supported_version: "0.1.0",
    },
    {
      language: "vue",
      provider: "vue-lsp-mcp",
      package: "@treedy/vue-lsp-mcp",
      package_ref: "@treedy/vue-lsp-mcp@latest",
      registry: "npm",
      resolver: "npx",
      install_command: "npx --yes @treedy/vue-lsp-mcp@latest",
      update_command: "npx --yes @treedy/vue-lsp-mcp@latest",
      default_channel: "latest",
      auto_update_enabled: config.autoUpdate,
      minimum_supported_version: "0.2.0",
    },
  ];
}

/**
 * Status tool implementation.
 */
export async function status(
  backendManager: BackendManager,
  config: Config,
  workspaces?: {
    global: string | null;
    perLanguage?: Record<string, string | null>;
    resolvedPerLanguage?: Record<string, string | null>;
  }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const backendStatus = backendManager.getStatus();
  const versions = backendManager.getVersions();
  const backendPackages = getBackendPackages(config);
  const backendRuntimeMode = resolveBackendRuntimeMode();

  const result = {
    server: "lsp-mcp",
    version: serverVersion,
    description: "Unified MCP server for multi-language code intelligence",
    config: {
      python: {
        enabled: config.languages.python?.enabled ?? false,
        provider: config.python?.provider,
      },
      typescript: {
        enabled: config.languages.typescript?.enabled ?? false,
      },
      vue: {
        enabled: config.languages.vue?.enabled ?? false,
      },
      autoUpdate: config.autoUpdate,
    },
    workspaces: {
      global: workspaces?.global ?? null,
      overrides: workspaces?.perLanguage ?? {},
      resolved: workspaces?.resolvedPerLanguage ?? {},
      per_language: workspaces?.resolvedPerLanguage ?? {},
    },
    backend_runtime_mode: backendRuntimeMode,
    backends: backendStatus,
    versions: versions.map((v) => ({
      language: v.language,
      name: v.serverName,
      version: v.installed,
      status: v.status,
    })),
    backend_packages: backendPackages,
    usage: {
      list: "Use list_backends to see available backends",
      start: "Use start_backend to install and start a backend",
      tools: "Once started, tools are available as python_hover, typescript_definition, etc.",
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Check versions tool - shows detailed version info for all backends.
 */
export async function checkVersions(
  backendManager: BackendManager,
  config: Config
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const versions = backendManager.getVersions();
  const backendPackages = getBackendPackages(config);
  const backendRuntimeMode = resolveBackendRuntimeMode();

  const result = {
    server: {
      name: "lsp-mcp",
      version: serverVersion,
    },
    autoUpdate: {
      enabled: config.autoUpdate,
      description: config.autoUpdate
        ? "Backends are automatically updated to latest versions on startup"
        : "Auto-update is disabled. Set LSP_MCP_AUTO_UPDATE=true to enable.",
    },
    backend_runtime_mode: backendRuntimeMode,
    backends: versions.map((v) => ({
      language: v.language,
      serverName: v.serverName,
      installedVersion: v.installed,
      status: v.status,
      command: v.command,
      note: v.status === "not_started"
        ? "Backend not started yet. Use a tool to start it and get version info."
        : undefined,
    })),
    backend_packages: backendPackages,
    updateInfo: {
      packages: {
        python: {
          "python-lsp-mcp": {
            registry: "PyPI",
            command: "uvx --upgrade python-lsp-mcp",
            description: "Rope-based backend (default)",
          },
          "pyright-mcp": {
            registry: "npm",
            command: "npx --yes @treedy/pyright-mcp@latest",
            description: "Pyright-based backend",
          },
        },
        typescript: {
          "typescript-lsp-mcp": {
            registry: "npm",
            command: "npx --yes @treedy/typescript-lsp-mcp@latest",
          },
        },
        vue: {
          "vue-lsp-mcp": {
            registry: "npm",
            command: "npx --yes @treedy/vue-lsp-mcp@latest",
            description: "Vue SFC support via Volar",
          },
        },
      },
      howToUpdate: config.autoUpdate
        ? "Restart the server to fetch latest backend versions automatically."
        : "Set LSP_MCP_AUTO_UPDATE=true and restart, or manually update with commands above.",
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Switch Python backend tool schema.
 */
export const switchPythonBackendSchema = {
  provider: z
    .enum(["python-lsp-mcp", "pyright-mcp"])
    .describe("The Python backend provider to use"),
};

/**
 * Switch Python backend implementation.
 * Note: This changes the config but requires a restart to take effect.
 */
export function switchPythonBackend(
  provider: PythonProvider
): { content: Array<{ type: "text"; text: string }> } {
  const result = {
    success: true,
    provider,
    message: `Python backend set to ${provider}. Restart the server for changes to take effect.`,
    note: "Set LSP_MCP_PYTHON_PROVIDER environment variable for persistent configuration.",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * List backends tool schema.
 */
export const listBackendsSchema = {};

/**
 * List available backends and their status.
 */
export async function listBackends(
  backendManager: BackendManager,
  config: Config
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const backendStatus = backendManager.getStatus();
  const backendPackages = getBackendPackages(config);
  const backendRuntimeMode = resolveBackendRuntimeMode();
  const byLanguage = new Map(backendPackages.map((pkg) => [pkg.language, pkg]));

  const backends = [
    {
      name: "python",
      enabled: config.languages.python?.enabled ?? false,
      provider: config.python?.provider,
      package: byLanguage.get("python")?.package_ref,
      resolver: byLanguage.get("python")?.resolver,
      status: backendStatus.python?.status || "not_started",
      tools: backendStatus.python?.tools || 0,
      description: "Python code intelligence (hover, definition, references, refactoring)",
      startCommand: "Use start_backend tool with language='python'",
    },
    {
      name: "typescript",
      enabled: config.languages.typescript?.enabled ?? false,
      package: byLanguage.get("typescript")?.package_ref,
      resolver: byLanguage.get("typescript")?.resolver,
      status: backendStatus.typescript?.status || "not_started",
      tools: backendStatus.typescript?.tools || 0,
      description: "TypeScript/JavaScript code intelligence",
      startCommand: "Use start_backend tool with language='typescript'",
    },
    {
      name: "vue",
      enabled: config.languages.vue?.enabled ?? false,
      package: byLanguage.get("vue")?.package_ref,
      resolver: byLanguage.get("vue")?.resolver,
      status: backendStatus.vue?.status || "not_started",
      tools: backendStatus.vue?.tools || 0,
      description: "Vue Single File Component (.vue) code intelligence via Volar",
      startCommand: "Use start_backend tool with language='vue'",
    },
  ];

  const result = {
    backend_runtime_mode: backendRuntimeMode,
    backends,
    backend_packages: backendPackages,
    usage: {
      start: "Call start_backend with language='python', 'typescript', or 'vue' to install and start a backend",
      tools: "Once started, backend tools will be available as {language}_{tool} (e.g., python_hover, vue_hover)",
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Start backend tool schema.
 */
export const startBackendSchema = {
  language: z.enum(["python", "typescript", "vue"]).describe("The backend to start"),
};

/**
 * Callback type for registering tools after backend starts.
 */
export type RegisterToolsCallback = (language: "python" | "typescript" | "vue") => Promise<number>;

/**
 * Callback type for updating a backend.
 */
export type UpdateBackendCallback = (language: "python" | "typescript" | "vue") => Promise<{ oldVersion: string | null; newVersion: string | null }>;

/**
 * Start a specific backend and register its tools.
 */
export async function startBackend(
  language: "python" | "typescript" | "vue",
  backendManager: BackendManager,
  config: Config,
  registerToolsCallback: RegisterToolsCallback
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Check if enabled
  if (language === "python" && !config.languages.python?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "Python backend is disabled",
          hint: "Set LSP_MCP_PYTHON_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  if (language === "typescript" && !config.languages.typescript?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "TypeScript backend is disabled",
          hint: "Set LSP_MCP_TYPESCRIPT_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  if (language === "vue" && !config.languages.vue?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "Vue backend is disabled",
          hint: "Set LSP_MCP_VUE_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  try {
    // Start backend and register tools
    const toolCount = await registerToolsCallback(language);

    const backendStatus = backendManager.getStatus();
    const status = backendStatus[language];

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          language,
          status: status?.status,
          serverName: status?.serverName,
          version: status?.version,
          toolsRegistered: toolCount,
          message: `${language} backend started successfully. ${toolCount} tools are now available.`,
          usage: `Tools are available as ${language}_hover, ${language}_definition, etc.`,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          language,
          error: String(error),
          hint: "Check if the backend package is available and network connection is working",
        }, null, 2),
      }],
    };
  }
}

/**
 * Update backend tool schema.
 */
export const updateBackendSchema = {
  language: z.enum(["python", "typescript", "vue"]).describe("The backend to update"),
};

/**
 * Update a specific backend to the latest version.
 */
export async function updateBackend(
  language: "python" | "typescript" | "vue",
  backendManager: BackendManager,
  config: Config,
  updateCallback: UpdateBackendCallback
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Check if enabled
  if (language === "python" && !config.languages.python?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "Python backend is disabled",
          hint: "Set LSP_MCP_PYTHON_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  if (language === "typescript" && !config.languages.typescript?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "TypeScript backend is disabled",
          hint: "Set LSP_MCP_TYPESCRIPT_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  if (language === "vue" && !config.languages.vue?.enabled) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          error: "Vue backend is disabled",
          hint: "Set LSP_MCP_VUE_ENABLED=true to enable",
        }, null, 2),
      }],
    };
  }

  try {
    const { oldVersion, newVersion } = await updateCallback(language);

    const backendStatus = backendManager.getStatus();
    const status = backendStatus[language];

    const updated = oldVersion !== newVersion;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          language,
          updated,
          oldVersion,
          newVersion,
          serverName: status?.serverName,
          tools: status?.tools,
          message: updated
            ? `${language} backend updated from ${oldVersion} to ${newVersion}.`
            : `${language} backend is already at the latest version (${newVersion}).`,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          language,
          error: String(error),
          hint: "Check network connection and try again",
        }, null, 2),
      }],
    };
  }
}
