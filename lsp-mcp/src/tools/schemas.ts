/**
 * Shared Zod schemas for tools.
 */

import { z } from "zod";

/**
 * Common position arguments for LSP tools.
 */
export const positionArgs = {
  file: z.string().describe("Absolute path to the file"),
  line: z.number().int().positive().describe("Line number (1-based)"),
  column: z.number().int().positive().describe("Column number (1-based)"),
};

/**
 * Common arguments for search tools.
 */
export const searchArgs = {
  pattern: z.string().describe("The regex pattern to search for"),
  path: z.string().optional().describe("Directory or file to search in"),
  glob: z.string().optional().describe("Glob pattern to filter files"),
  caseSensitive: z.boolean().default(true).describe("Whether the search is case sensitive"),
  maxResults: z.number().int().positive().default(50).describe("Maximum number of results"),
};

/**
 * Arguments for diagnostics tools.
 */
export const diagnosticsArgs = {
  path: z.string().describe("Path to a file or directory to check"),
};

/**
 * Arguments for rename tools.
 */
export const renameArgs = {
  ...positionArgs,
  newName: z.string().describe("New name for the symbol"),
};

/**
 * Arguments for symbols tools.
 */
export const symbolsArgs = {
  file: z.string().describe("Absolute path to the file"),
  query: z.string().optional().describe("Optional filter query for symbol names"),
};

/**
 * Arguments for update_document tools.
 */
export const updateDocumentArgs = {
  file: z.string().describe("Absolute path to the file"),
  content: z.string().describe("New content for the file"),
};

/**
 * Arguments for completions tools.
 */
export const completionsArgs = {
  ...positionArgs,
  limit: z.number().int().positive().default(20).describe("Maximum number of completions to return"),
};
