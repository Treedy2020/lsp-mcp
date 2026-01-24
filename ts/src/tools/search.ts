import { z } from 'zod';
import { execSync } from 'child_process';
import * as path from 'path';

export const searchSchema = {
  pattern: z.string().describe('The regex pattern to search for'),
  path: z.string().optional().describe('Directory or file to search in (defaults to current working directory)'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.py", "**/*.ts")'),
  caseSensitive: z.boolean().optional().default(true).describe('Whether the search is case sensitive'),
  maxResults: z.number().int().positive().optional().default(50).describe('Maximum number of results to return'),
};

interface SearchResult {
  file: string;
  line: number;
  column: number;
  text: string;
  match: string;
}

export async function search(args: {
  pattern: string;
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const searchPath = args.path || process.cwd();
  const caseSensitive = args.caseSensitive ?? true;
  const maxResults = args.maxResults ?? 50;

  // Build rg command
  const rgArgs: string[] = [
    '--json',
    '--line-number',
    '--column',
  ];

  if (!caseSensitive) {
    rgArgs.push('--ignore-case');
  }

  if (args.glob) {
    rgArgs.push('--glob', args.glob);
  }

  rgArgs.push('--', args.pattern, searchPath);

  try {
    const result = execSync(`rg ${rgArgs.map(a => `'${a}'`).join(' ')}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const results: SearchResult[] = [];
    const lines = result.split('\n').filter(Boolean);

    for (const line of lines) {
      if (results.length >= maxResults) break;

      try {
        const json = JSON.parse(line);
        if (json.type === 'match') {
          const data = json.data;
          const filePath = data.path.text;
          const lineNumber = data.line_number;
          const lineText = data.lines.text.trimEnd();

          // Get all matches in this line
          for (const submatch of data.submatches) {
            if (results.length >= maxResults) break;
            results.push({
              file: path.resolve(filePath),
              line: lineNumber,
              column: submatch.start + 1, // Convert to 1-based
              text: lineText,
              match: submatch.match.text,
            });
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No matches found for pattern: ${args.pattern}` }],
      };
    }

    let output = `**Search Results** for \`${args.pattern}\`\n\n`;
    output += `Found ${results.length} match(es)${results.length >= maxResults ? ` (limited to ${maxResults})` : ''}:\n\n`;

    for (const r of results) {
      output += `**${r.file}:${r.line}:${r.column}**\n`;
      output += `  \`${r.text}\`\n`;
      output += `  Match: \`${r.match}\`\n\n`;
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    if (error.status === 1) {
      // rg returns 1 when no matches found
      return {
        content: [{ type: 'text', text: `No matches found for pattern: ${args.pattern}` }],
      };
    }
    return {
      content: [{ type: 'text', text: `Search error: ${error.message || 'Unknown error'}` }],
    };
  }
}
