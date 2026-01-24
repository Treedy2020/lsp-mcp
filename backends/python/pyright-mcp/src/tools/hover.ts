import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';
import { toPosition, formatRange } from '../utils/position.js';
import { MarkupContent } from 'vscode-languageserver-protocol';

export const hoverSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
};

export async function hover(args: { file: string; line: number; column: number }) {
  console.error(`[hover] Starting hover for ${args.file}:${args.line}:${args.column}`);
  const client = getLspClient();
  const position = toPosition(args.line, args.column);

  console.error(`[hover] Calling LSP hover...`);
  const result = await client.hover(args.file, position);
  console.error(`[hover] Got result: ${result ? 'yes' : 'no'}`);

  if (!result) {
    return {
      content: [{ type: 'text' as const, text: 'No hover information available at this position.' }],
    };
  }

  let hoverText = '';

  if (typeof result.contents === 'string') {
    hoverText = result.contents;
  } else if (Array.isArray(result.contents)) {
    hoverText = result.contents
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n\n');
  } else if ('kind' in result.contents) {
    hoverText = (result.contents as MarkupContent).value;
  } else if ('value' in result.contents) {
    hoverText = result.contents.value;
  }

  let output = `**Hover Info** at ${args.file}:${args.line}:${args.column}\n\n`;
  output += hoverText;

  if (result.range) {
    output += `\n\n**Range:** ${formatRange(result.range)}`;
  }

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
