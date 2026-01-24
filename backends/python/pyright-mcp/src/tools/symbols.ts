import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';
import { DocumentSymbol, SymbolKind } from 'vscode-languageserver-protocol';
import { SymbolKindNames, SymbolFilter } from '../lsp/types.js';

export const symbolsSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  filter: z
    .enum(['all', 'classes', 'functions', 'methods', 'variables'])
    .optional()
    .default('all')
    .describe('Filter symbols by type'),
  includeChildren: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include nested symbols (e.g., methods inside classes)'),
};

/**
 * Get the symbol kind name from the SymbolKind enum value
 */
function getSymbolKindName(kind: SymbolKind): string {
  return SymbolKindNames[kind] || 'Unknown';
}

/**
 * Check if a symbol matches the filter
 */
function matchesFilter(kind: SymbolKind, filter: SymbolFilter): boolean {
  if (filter === 'all') {
    return true;
  }

  switch (filter) {
    case 'classes':
      return kind === SymbolKind.Class;
    case 'functions':
      return kind === SymbolKind.Function;
    case 'methods':
      return kind === SymbolKind.Method;
    case 'variables':
      return kind === SymbolKind.Variable || kind === SymbolKind.Constant;
    default:
      return true;
  }
}

/**
 * Format a symbol and its children recursively
 */
function formatSymbol(
  symbol: DocumentSymbol,
  filter: SymbolFilter,
  includeChildren: boolean,
  indent: number = 0
): string[] {
  const lines: string[] = [];
  const indentStr = '  '.repeat(indent);
  const kindName = getSymbolKindName(symbol.kind);
  const line = symbol.range.start.line + 1; // Convert to 1-based

  // Check if this symbol matches the filter
  const symbolMatches = matchesFilter(symbol.kind, filter);

  if (symbolMatches) {
    lines.push(`${indentStr}- **${symbol.name}** (${kindName}) at line ${line}`);
  }

  // Process children
  if (includeChildren && symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      const childLines = formatSymbol(
        child,
        filter,
        includeChildren,
        symbolMatches ? indent + 1 : indent
      );
      lines.push(...childLines);
    }
  }

  return lines;
}

/**
 * Check if result is DocumentSymbol array (has 'range' property)
 */
function isDocumentSymbolArray(
  result: unknown
): result is DocumentSymbol[] {
  return (
    Array.isArray(result) &&
    result.length > 0 &&
    'range' in result[0]
  );
}

export async function symbols(args: {
  file: string;
  filter?: SymbolFilter;
  includeChildren?: boolean;
}) {
  const filter = args.filter || 'all';
  const includeChildren = args.includeChildren !== false;

  console.error(`[symbols] Getting symbols for ${args.file} (filter: ${filter})`);
  const client = getLspClient();

  const result = await client.documentSymbols(args.file);
  console.error(`[symbols] Got result: ${result ? `${(result as unknown[]).length} symbols` : 'no'}`);

  if (!result || (Array.isArray(result) && result.length === 0)) {
    return {
      content: [{ type: 'text' as const, text: `No symbols found in ${args.file}` }],
    };
  }

  let output = `**Symbols** in ${args.file}\n\n`;

  if (isDocumentSymbolArray(result)) {
    // DocumentSymbol[] - hierarchical
    const lines: string[] = [];
    for (const symbol of result) {
      lines.push(...formatSymbol(symbol, filter, includeChildren));
    }

    if (lines.length === 0) {
      output += `No ${filter} symbols found.`;
    } else {
      output += lines.join('\n');
    }
  } else {
    // SymbolInformation[] - flat list
    const filteredSymbols = result.filter((s) => matchesFilter(s.kind, filter));

    if (filteredSymbols.length === 0) {
      output += `No ${filter} symbols found.`;
    } else {
      for (const symbol of filteredSymbols) {
        const kindName = getSymbolKindName(symbol.kind);
        const line = symbol.location.range.start.line + 1;
        output += `- **${symbol.name}** (${kindName}) at line ${line}\n`;
      }
    }
  }

  return {
    content: [{ type: 'text' as const, text: output.trim() }],
  };
}
