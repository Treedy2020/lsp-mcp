import { Position, Range, Location } from 'vscode-languageserver-protocol';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Convert 1-based line/column (user input) to 0-based LSP Position
 */
export function toPosition(line: number, column: number): Position {
  return Position.create(line - 1, column - 1);
}

/**
 * Convert 0-based LSP Position to 1-based line/column (user output)
 */
export function fromPosition(pos: Position): { line: number; column: number } {
  return {
    line: pos.line + 1,
    column: pos.character + 1,
  };
}

/**
 * Format a Location for display
 */
export function formatLocation(loc: Location): string {
  const start = fromPosition(loc.range.start);
  const end = fromPosition(loc.range.end);
  return `${loc.uri}:${start.line}:${start.column}-${end.line}:${end.column}`;
}

/**
 * Format a Range for display
 */
export function formatRange(range: Range): string {
  const start = fromPosition(range.start);
  const end = fromPosition(range.end);
  return `${start.line}:${start.column}-${end.line}:${end.column}`;
}

/**
 * Convert file path to URI
 */
export function pathToUri(filePath: string): string {
  if (filePath.startsWith('file://')) {
    return filePath;
  }
  return `file://${filePath}`;
}

/**
 * Convert URI to file path
 */
export function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return uri.slice(7);
  }
  return uri;
}

/**
 * Find project root by looking for pyrightconfig.json or pyproject.toml
 * starting from the given file path and walking up the directory tree
 */
export function findProjectRoot(filePath: string): string {
  const configFiles = ['pyrightconfig.json', 'pyproject.toml', '.git'];
  let dir = dirname(resolve(filePath));
  const root = '/';

  while (dir !== root) {
    for (const configFile of configFiles) {
      if (existsSync(join(dir, configFile))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback to file's directory
  return dirname(resolve(filePath));
}
