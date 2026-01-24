/**
 * TypeScript backend configuration.
 *
 * Defines the tools available from the TypeScript backend and their schemas.
 */

import { z } from "zod";

/**
 * Common position schema for TypeScript tools.
 */
export const typescriptPositionSchema = {
  file: z.string().describe("Absolute path to the TypeScript/JavaScript file"),
  line: z.number().int().positive().describe("Line number (1-based)"),
  column: z.number().int().positive().describe("Column number (1-based)"),
};

/**
 * Tool descriptions for TypeScript backend.
 */
export const typescriptToolDescriptions: Record<string, string> = {
  hover: "Get type information and documentation at a specific position in a TypeScript/JavaScript file",
  definition: "Go to definition of a symbol at a specific position",
  references: "Find all references to a symbol at a specific position",
  completions: "Get code completion suggestions at a specific position",
  diagnostics: "Get type errors and warnings for a TypeScript/JavaScript file",
  symbols: "Extract symbols (classes, functions, methods, variables) from a file",
  rename: "Preview renaming a symbol (shows all locations that would be renamed)",
  search: "Search for a regex pattern in TypeScript/JavaScript files",
  signature_help: "Get function signature help at a specific position",
  update_document: "Update file content for incremental analysis",
  status: "Check TypeScript environment status for a project",
};

/**
 * Get the namespaced tool name for a TypeScript tool.
 */
export function getTypescriptToolName(tool: string): string {
  return `typescript/${tool}`;
}
