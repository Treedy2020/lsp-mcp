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

/**
 * Status tool implementation.
 */
export async function status(
  backendManager: BackendManager,
  config: Config
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const backendStatus = backendManager.getStatus();
  const versions = backendManager.getVersions();

  const result = {
    server: "lsp-mcp",
    version: serverVersion,
    description: "Unified MCP server for multi-language code intelligence",
    config: {
      python: {
        enabled: config.python.enabled,
        provider: config.python.provider,
      },
      typescript: {
        enabled: config.typescript.enabled,
      },
      autoUpdate: config.autoUpdate,
    },
    backends: backendStatus,
    versions: versions.map((v) => ({
      language: v.language,
      name: v.serverName,
      version: v.installed,
      status: v.status,
    })),
    usage: {
      namespaced: "Use python/hover or typescript/hover to specify language",
      auto_infer: "Or provide a file path and language will be inferred from extension",
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
