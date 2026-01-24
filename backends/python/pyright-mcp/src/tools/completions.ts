import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';
import { toPosition } from '../utils/position.js';
import { CompletionItem, CompletionItemKind, CompletionList } from 'vscode-languageserver-protocol';

export const completionsSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
  limit: z.number().int().positive().optional().default(20).describe('Maximum number of completions to return'),
};

const kindNames: Record<number, string> = {
  [CompletionItemKind.Text]: 'Text',
  [CompletionItemKind.Method]: 'Method',
  [CompletionItemKind.Function]: 'Function',
  [CompletionItemKind.Constructor]: 'Constructor',
  [CompletionItemKind.Field]: 'Field',
  [CompletionItemKind.Variable]: 'Variable',
  [CompletionItemKind.Class]: 'Class',
  [CompletionItemKind.Interface]: 'Interface',
  [CompletionItemKind.Module]: 'Module',
  [CompletionItemKind.Property]: 'Property',
  [CompletionItemKind.Unit]: 'Unit',
  [CompletionItemKind.Value]: 'Value',
  [CompletionItemKind.Enum]: 'Enum',
  [CompletionItemKind.Keyword]: 'Keyword',
  [CompletionItemKind.Snippet]: 'Snippet',
  [CompletionItemKind.Color]: 'Color',
  [CompletionItemKind.File]: 'File',
  [CompletionItemKind.Reference]: 'Reference',
  [CompletionItemKind.Folder]: 'Folder',
  [CompletionItemKind.EnumMember]: 'EnumMember',
  [CompletionItemKind.Constant]: 'Constant',
  [CompletionItemKind.Struct]: 'Struct',
  [CompletionItemKind.Event]: 'Event',
  [CompletionItemKind.Operator]: 'Operator',
  [CompletionItemKind.TypeParameter]: 'TypeParameter',
};

export async function completions(args: {
  file: string;
  line: number;
  column: number;
  limit?: number;
}) {
  const client = getLspClient();
  const position = toPosition(args.line, args.column);
  const limit = args.limit ?? 20;

  const result = await client.completions(args.file, position);

  if (!result) {
    return {
      content: [{ type: 'text' as const, text: 'No completions available at this position.' }],
    };
  }

  let items: CompletionItem[];

  if (Array.isArray(result)) {
    items = result;
  } else {
    items = (result as CompletionList).items;
  }

  if (items.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No completions available at this position.' }],
    };
  }

  const limitedItems = items.slice(0, limit);

  let output = `**Completions** at ${args.file}:${args.line}:${args.column}\n\n`;
  output += `Showing ${limitedItems.length} of ${items.length} completion(s):\n\n`;

  for (const item of limitedItems) {
    const kind = item.kind ? kindNames[item.kind] || 'Unknown' : 'Unknown';
    const detail = item.detail ? ` - ${item.detail}` : '';
    output += `- **${item.label}** (${kind})${detail}\n`;
  }

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
