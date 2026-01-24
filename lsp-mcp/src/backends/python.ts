/**
 * Python backend configuration.
 *
 * Defines the tools available from the Python backend and their schemas.
 */

import { z } from "zod";

/**
 * Common position schema for Python tools.
 */
export const pythonPositionSchema = {
  file: z.string().describe("Absolute path to the Python file"),
  line: z.number().int().positive().describe("Line number (1-based)"),
  column: z.number().int().positive().describe("Column number (1-based)"),
};

/**
 * Python-specific tools that are not available in TypeScript.
 */
export const pythonOnlyTools = [
  "move",
  "change_signature",
  "function_signature",
  "set_backend",
  "set_python_path",
  "reload_modules",
];

/**
 * Tool descriptions for Python backend.
 */
export const pythonToolDescriptions: Record<string, string> = {
  hover: "Get type information and documentation at a specific position in a Python file",
  definition: "Go to definition of a symbol at a specific position in a Python file",
  references: "Find all references to a symbol at a specific position in a Python file",
  completions: "Get code completion suggestions at a specific position in a Python file",
  diagnostics: "Get type errors and warnings for a Python file or directory",
  symbols: "Extract symbols (classes, functions, methods, variables) from a Python file",
  rename: "Rename a symbol and update all references in Python files",
  search: "Search for a regex pattern in Python files",
  signature_help: "Get function signature help at a specific position in a Python file",
  update_document: "Update file content for incremental analysis in Python",
  status: "Check Python/Pyright environment status",
  move: "Move a function or class to another Python module",
  change_signature: "Change the signature of a Python function",
  function_signature: "Get the current signature of a Python function",
  set_backend: "Set the backend (rope/pyright) for Python code analysis",
  set_python_path: "Set the Python interpreter path for code analysis",
};

/**
 * Get the namespaced tool name for a Python tool.
 */
export function getPythonToolName(tool: string): string {
  return `python/${tool}`;
}
