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
  lastUsed: number;
  retryCount: number;
  lastCrashTime: number;
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
  private idleCheckInterval: NodeJS.Timer | null = null;

  constructor(config: Config) {
    this.config = config;
    
    // Start idle check if enabled
    if (this.config.idleTimeout > 0) {
      // Check every minute
      this.idleCheckInterval = setInterval(() => this.checkIdle(), 60 * 1000);
      // Ensure we don't block process exit
      if (this.idleCheckInterval.unref) {
        this.idleCheckInterval.unref();
      }
    }
  }

  /**
   * Check for idle backends and shut them down.
   */
  private async checkIdle(): Promise<void> {
    const now = Date.now();
    const timeoutMs = this.config.idleTimeout * 1000;

    for (const [lang, state] of this.backends.entries()) {
      if (state.status === "ready" && (now - state.lastUsed) > timeoutMs) {
        console.error(`[BackendManager] ${lang} backend idle for ${this.config.idleTimeout}s, shutting down...`);
        await this.shutdownBackend(lang);
      }
    }
  }

  /**
   * Update the configuration.
   * This does not automatically restart backends, but new backends will use the new config.
   * To apply changes to running backends, they need to be restarted.
   */
  updateConfig(newConfig: Config): void {
    this.config = newConfig;
    
    // Update idle timer if changed
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    
    if (this.config.idleTimeout > 0) {
      this.idleCheckInterval = setInterval(() => this.checkIdle(), 60 * 1000);
      if (this.idleCheckInterval.unref) {
        this.idleCheckInterval.unref();
      }
    }
  }

  /**
   * Get or start a backend for a language.
   * Returns the backend state, starting it if necessary.
   */
  async getBackend(language: Language): Promise<BackendState> {
    // Return existing ready backend
    const existing = this.backends.get(language);
    if (existing && existing.status === "ready") {
      existing.lastUsed = Date.now();
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
   * Monitor backend for crashes and trigger recovery.
   */
  private monitorBackend(language: Language, transport: StdioClientTransport): void {
    transport.onclose = async () => {
      const state = this.backends.get(language);
      // If manually stopped, do nothing
      if (!state || state.status === "stopped") return;

      console.error(`[BackendManager] ${language} backend connection closed unexpectedly.`);
      state.status = "error";
      state.lastError = "Connection closed unexpectedly";
      await this.handleCrash(language);
    };

    transport.onerror = async (error) => {
      const state = this.backends.get(language);
      if (!state || state.status === "stopped") return;

      console.error(`[BackendManager] ${language} backend transport error:`, error);
      // onerror might not mean full crash, but usually precedes it
    };
  }

  /**
   * Handle backend crash with exponential backoff.
   */
  private async handleCrash(language: Language): Promise<void> {
    const state = this.backends.get(language);
    if (!state) return;

    const now = Date.now();
    // Reset retry count if last crash was over 1 hour ago
    if (now - state.lastCrashTime > 3600 * 1000) {
      state.retryCount = 0;
    }

    state.retryCount++;
    state.lastCrashTime = now;

    const maxRetries = 5;
    if (state.retryCount > maxRetries) {
      console.error(`[BackendManager] ${language} crashed too many times (${state.retryCount}). Giving up.`);
      state.status = "error";
      state.lastError = `Crashed ${state.retryCount} times. Manual restart required.`;
      return;
    }

    const backoffMs = Math.min(1000 * Math.pow(2, state.retryCount - 1), 30000);
    console.error(`[BackendManager] Restarting ${language} in ${backoffMs}ms (Attempt ${state.retryCount}/${maxRetries})...`);

    // Wait and restart
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    
    // Check if we are still in a state that needs restart (might have been stopped manually during wait)
    const currentState = this.backends.get(language);
    if (!currentState || currentState.status === "stopped") return;

    try {
      // Remove old state to force fresh start
      this.backends.delete(language);
      const startPromise = this.startBackend(language);
      this.startPromises.set(language, startPromise);
      await startPromise;
      this.startPromises.delete(language);
      
      // Restore retry state to the new instance so we don't reset count immediately
      const newState = this.backends.get(language);
      if (newState) {
        newState.retryCount = state.retryCount;
        newState.lastCrashTime = state.lastCrashTime;
      }
      console.error(`[BackendManager] ${language} recovered successfully.`);
    } catch (error) {
      console.error(`[BackendManager] Failed to recover ${language}:`, error);
      // Recursively handle crash if restart fails immediately
      // But we need to make sure we don't infinite loop if startBackend throws sync.
      // startBackend creates state before throwing, so handleCrash should work if we put it back in map.
      // Actually startBackend throws -> we catch -> we are here.
      // We should probably rely on the next getBackend call or try again?
      // For simplicity, just log. The next user call will try to start again.
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
      lastUsed: Date.now(),
      retryCount: 0,
      lastCrashTime: 0,
    };

    this.backends.set(language, state);
    
    // Setup monitoring
    this.monitorBackend(language, transport);

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
      // Reset retry count on successful sustained start (simplified: just set ready)
      // We don't reset retryCount immediately to avoid crash loops that stay alive just long enough.
      // We rely on the time-window check in handleCrash.

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
      state.lastUsed = Date.now();
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
        restarted.lastUsed = Date.now();
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
    const languages = Object.keys(this.config.languages).filter(
      (lang) => this.config.languages[lang].enabled
    );

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
   * Shutdown a specific backend.
   */
  async shutdownBackend(language: Language): Promise<void> {
    const state = this.backends.get(language);
    if (!state) return;

    try {
      console.error(`[BackendManager] Shutting down ${language}...`);
      await state.transport.close();
      await state.client.close();
    } catch (error) {
      console.error(`[BackendManager] Error closing ${language}:`, error);
    } finally {
      this.backends.delete(language);
    }
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
    for (const [lang, config] of Object.entries(this.config.languages)) {
      if (config.enabled && !this.backends.has(lang)) {
        status[lang] = { status: "not_started", tools: 0, restartCount: 0 };
      }
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
    const languages = Object.keys(this.config.languages).filter(
      (lang) => this.config.languages[lang].enabled
    );

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

    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

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
