import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';
import { toPosition, fromPosition, uriToPath } from '../utils/position.js';
import { Location, LocationLink } from 'vscode-languageserver-protocol';

export const definitionSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
};

export async function definition(args: { file: string; line: number; column: number }) {
  const client = getLspClient();
  const position = toPosition(args.line, args.column);

  const result = await client.definition(args.file, position);

  if (!result) {
    return {
      content: [{ type: 'text' as const, text: 'No definition found at this position.' }],
    };
  }

  const locations: Array<{ file: string; line: number; column: number }> = [];

  if (Array.isArray(result)) {
    for (const item of result) {
      if ('targetUri' in item) {
        // LocationLink
        const link = item as LocationLink;
        const pos = fromPosition(link.targetSelectionRange.start);
        locations.push({
          file: uriToPath(link.targetUri),
          line: pos.line,
          column: pos.column,
        });
      } else {
        // Location
        const loc = item as Location;
        const pos = fromPosition(loc.range.start);
        locations.push({
          file: uriToPath(loc.uri),
          line: pos.line,
          column: pos.column,
        });
      }
    }
  } else {
    // Single Location
    const loc = result as Location;
    const pos = fromPosition(loc.range.start);
    locations.push({
      file: uriToPath(loc.uri),
      line: pos.line,
      column: pos.column,
    });
  }

  if (locations.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No definition found at this position.' }],
    };
  }

  let output = `**Definition(s)** for symbol at ${args.file}:${args.line}:${args.column}\n\n`;

  for (const loc of locations) {
    output += `- ${loc.file}:${loc.line}:${loc.column}\n`;
  }

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
