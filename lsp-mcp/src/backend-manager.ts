/**
 * Backend Manager
 *
 * Manages MCP subprocess backends with:
 * - Lazy loading (backends started on first use)
 * - Health checks and automatic restart
 * - Graceful shutdown handling
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Language, Config } from "./config.js";
import { getBackendCommand } from "./config.js";

interface BackendState {
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  status: "starting" | "ready" | "error" | "stopped";
  lastError?: string;
  restartCount: number;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export interface BackendVersionInfo {
  language: Language;
  installed: string | null;
  serverName: string | null;
  status: "ready" | "not_started" | "error";
  command: string;
}

export class BackendManager {
  private backends: Map<Language, BackendState> = new Map();
  private startPromises: Map<Language, Promise<BackendState>> = new Map();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Get or start a backend for a language.
   * Returns the backend state, starting it if necessary.
   */
  async getBackend(language: Language): Promise<BackendState> {
    // Return existing ready backend
    const existing = this.backends.get(language);
    if (existing && existing.status === "ready") {
      return existing;
    }

    // Return in-progress start
    const pending = this.startPromises.get(language);
    if (pending) {
      return pending;
    }

    // Start new backend
    const startPromise = this.startBackend(language);
    this.startPromises.set(language, startPromise);

    try {
      const state = await startPromise;
      return state;
    } finally {
      this.startPromises.delete(language);
    }
  }

  /**
   * Start a backend subprocess for a language.
   */
  private async startBackend(language: Language): Promise<BackendState> {
    const backendConfig = getBackendCommand(language, this.config);
    if (!backendConfig) {
      throw new Error(`Backend for ${language} is not enabled`);
    }

    console.error(`[BackendManager] Starting ${language} backend...`);
    console.error(`[BackendManager] Command: ${backendConfig.command} ${backendConfig.args.join(" ")}`);

    const { command, args } = backendConfig;

    // Create MCP client transport (this spawns the subprocess)
    const transport = new StdioClientTransport({
      command,
      args,
      stderr: "pipe",
    });

    // Create MCP client
    const client = new Client(
      {
        name: `lsp-mcp-${language}-client`,
        version: "0.1.0",
      },
      {
        capabilities: {},
      }
    );

    // Create initial state
    const state: BackendState = {
      client,
      transport,
      tools: [],
      status: "starting",
      restartCount: 0,
    };

    this.backends.set(language, state);

    try {
      // Connect to the backend
      await client.connect(transport);

      // Get server info (name and version)
      const serverInfo = client.getServerVersion();
      if (serverInfo) {
        state.serverInfo = {
          name: serverInfo.name,
          version: serverInfo.version,
        };
      }

      // Get available tools
      const toolsResponse = await client.listTools();
      state.tools = toolsResponse.tools;
      state.status = "ready";

      console.error(
        `[BackendManager] ${language} backend ready: ${state.serverInfo?.name}@${state.serverInfo?.version} (${state.tools.length} tools)`
      );

      return state;
    } catch (error) {
      state.status = "error";
      state.lastError = String(error);
      console.error(`[BackendManager] Failed to start ${language}:`, error);
      throw error;
    }
  }

  /**
   * Call a tool on a backend.
   */
  async callTool(
    language: Language,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const state = await this.getBackend(language);

    if (state.status !== "ready") {
      throw new Error(`${language} backend is not ready: ${state.lastError}`);
    }

    try {
      const result = await state.client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as { content: Array<{ type: "text"; text: string }> };
    } catch (error) {
      state.status = "error";
      state.lastError = String(error);
      console.error(`[BackendManager] ${language} tool call failed, attempting restart:`, error);
      try {
        await this.restartBackend(language);
        const restarted = this.backends.get(language);
        if (!restarted || restarted.status !== "ready") {
          throw new Error(`${language} backend failed to restart`);
        }
        const result = await restarted.client.callTool({
          name: toolName,
          arguments: args,
        });
        return result as { content: Array<{ type: "text"; text: string }> };
      } catch (restartError) {
        throw new Error(`${language} backend error after restart: ${restartError}`);
      }
    }
  }

  /**
   * Get all tools from a backend.
   */
  async getTools(language: Language): Promise<Tool[]> {
    const state = await this.getBackend(language);
    return state.tools;
  }

  /**
   * Get all tools from all enabled backends.
   */
  async getAllTools(): Promise<Map<Language, Tool[]>> {
    const result = new Map<Language, Tool[]>();
    const languages: Language[] = [];

    if (this.config.python.enabled) languages.push("python");
    if (this.config.typescript.enabled) languages.push("typescript");
    if (this.config.vue.enabled) languages.push("vue");

    await Promise.all(
      languages.map(async (lang) => {
        try {
          const tools = await this.getTools(lang);
          result.set(lang, tools);
        } catch (error) {
          console.error(`[BackendManager] Failed to get tools for ${lang}:`, error);
          result.set(lang, []);
        }
      })
    );

    return result;
  }

  /**
   * Get status of all backends.
   */
  getStatus(): Record<
    Language,
    { status: string; tools: number; restartCount: number; error?: string; version?: string; serverName?: string }
  > {
    const status: Record<
      string,
      { status: string; tools: number; restartCount: number; error?: string; version?: string; serverName?: string }
    > = {};

    for (const [lang, state] of this.backends) {
      status[lang] = {
        status: state.status,
        tools: state.tools.length,
        restartCount: state.restartCount,
        error: state.lastError,
        version: state.serverInfo?.version,
        serverName: state.serverInfo?.name,
      };
    }

    // Add configured but not started backends
    if (this.config.python.enabled && !this.backends.has("python")) {
      status["python"] = { status: "not_started", tools: 0, restartCount: 0 };
    }
    if (this.config.typescript.enabled && !this.backends.has("typescript")) {
      status["typescript"] = { status: "not_started", tools: 0, restartCount: 0 };
    }
    if (this.config.vue.enabled && !this.backends.has("vue")) {
      status["vue"] = { status: "not_started", tools: 0, restartCount: 0 };
    }

    return status as Record<
      Language,
      { status: string; tools: number; restartCount: number; error?: string; version?: string; serverName?: string }
    >;
  }

  /**
   * Get version information for all configured backends.
   */
  getVersions(): BackendVersionInfo[] {
    const versions: BackendVersionInfo[] = [];
    const languages: Language[] = [];

    if (this.config.python.enabled) languages.push("python");
    if (this.config.typescript.enabled) languages.push("typescript");
    if (this.config.vue.enabled) languages.push("vue");

    for (const lang of languages) {
      const backendConfig = getBackendCommand(lang, this.config);
      const state = this.backends.get(lang);

      versions.push({
        language: lang,
        installed: state?.serverInfo?.version ?? null,
        serverName: state?.serverInfo?.name ?? null,
        status: state?.status === "ready" ? "ready" : state?.status === "error" ? "error" : "not_started",
        command: backendConfig ? `${backendConfig.command} ${backendConfig.args.join(" ")}` : "not configured",
      });
    }

    return versions;
  }

  /**
   * Restart a backend to pick up updates.
   * Returns the old and new version.
   */
  async restartBackend(language: Language): Promise<{ oldVersion: string | null; newVersion: string | null }> {
    const existing = this.backends.get(language);
    const oldVersion = existing?.serverInfo?.version ?? null;
    const restartCount = (existing?.restartCount ?? 0) + 1;

    // Stop the existing backend if running
    if (existing) {
      console.error(`[BackendManager] Stopping ${language} for update...`);
      try {
        await existing.transport.close();
        await existing.client.close();
      } catch (error) {
        console.error(`[BackendManager] Error closing ${language}:`, error);
      }
      this.backends.delete(language);
    }

    // Start a fresh backend (will fetch latest version due to auto-update flags)
    console.error(`[BackendManager] Starting fresh ${language} backend...`);
    const state = await this.startBackend(language);
    state.restartCount = restartCount;
    const newVersion = state.serverInfo?.version ?? null;

    return { oldVersion, newVersion };
  }

  /**
   * Gracefully shutdown all backends.
   */
  async shutdown(): Promise<void> {
    console.error("[BackendManager] Shutting down all backends...");

    const shutdownPromises = Array.from(this.backends.entries()).map(
      async ([lang, state]) => {
        try {
          console.error(`[BackendManager] Closing ${lang}...`);
          await state.transport.close();
          await state.client.close();
          state.status = "stopped";
        } catch (error) {
          console.error(`[BackendManager] Error closing ${lang}:`, error);
        }
      }
    );

    await Promise.all(shutdownPromises);
    this.backends.clear();
    console.error("[BackendManager] All backends stopped");
  }
}
