/**
 * Tool Router
 *
 * Routes tool calls to the appropriate backend based on:
 * - Tool name prefix (python/hover, typescript/definition)
 * - File extension inference from arguments
 */

import type { Language } from "./config.js";
import { parseToolName, inferLanguageFromPath } from "./config.js";
import type { BackendManager } from "./backend-manager.js";

export interface RouteResult {
  language: Language;
  toolName: string;
}

/**
 * Route a tool call to the appropriate backend.
 *
 * @param toolName - The tool name (e.g., "python/hover" or "hover")
 * @param args - The tool arguments (may contain "file" or "path" for inference)
 * @returns The routing result with language and actual tool name
 */
export function routeTool(
  toolName: string,
  args: Record<string, unknown>
): RouteResult {
  // First, try to parse namespaced tool name
  const parsed = parseToolName(toolName);
  if (parsed) {
    return {
      language: parsed.language,
      toolName: parsed.tool,
    };
  }

  // Otherwise, try to infer from file path in arguments
  const filePath = (args.file as string) || (args.path as string);
  if (filePath) {
    const language = inferLanguageFromPath(filePath);
    if (language) {
      return {
        language,
        toolName,
      };
    }
  }

  throw new Error(
    `Cannot determine language for tool "${toolName}". ` +
      `Use namespaced tool names like "python/${toolName}" or "typescript/${toolName}", ` +
      `or provide a file path in the arguments.`
  );
}

/**
 * Tool Router class that manages routing and calling tools.
 */
export class ToolRouter {
  private backendManager: BackendManager;

  constructor(backendManager: BackendManager) {
    this.backendManager = backendManager;
  }

  /**
   * Call a tool, routing to the appropriate backend.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const route = routeTool(toolName, args);

    return this.backendManager.callTool(
      route.language,
      route.toolName,
      args
    );
  }

  /**
   * Check if a tool name is a namespaced tool.
   */
  isNamespacedTool(toolName: string): boolean {
    return parseToolName(toolName) !== null;
  }

  /**
   * Get available languages.
   */
  getLanguages(): Language[] {
    return ["python", "typescript"];
  }
}
