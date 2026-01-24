import { z } from 'zod';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { findProjectRoot } from '../utils/position.js';

export const referencesSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
};

interface Reference {
  file: string;
  line: number;
  column: number;
  text: string;
  isDefinition?: boolean;
}

function getSymbolAtPosition(filePath: string, line: number, column: number): string | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const targetLine = lines[line - 1];
    if (!targetLine) return null;

    // Find word at position
    const col = column - 1;
    let start = col;
    let end = col;

    // Expand left
    while (start > 0 && /[\w_]/.test(targetLine[start - 1])) {
      start--;
    }
    // Expand right
    while (end < targetLine.length && /[\w_]/.test(targetLine[end])) {
      end++;
    }

    const symbol = targetLine.slice(start, end);
    return symbol.length > 0 ? symbol : null;
  } catch {
    return null;
  }
}

export async function references(args: { file: string; line: number; column: number }) {
  const { file, line, column } = args;

  // Get symbol name at position
  const symbol = getSymbolAtPosition(file, line, column);
  if (!symbol) {
    return {
      content: [{ type: 'text' as const, text: 'Could not identify symbol at this position.' }],
    };
  }

  // Find project root
  const projectRoot = findProjectRoot(file);

  // Use ripgrep to find all references in Python files
  // Match word boundaries to avoid partial matches
  const pattern = `\\b${symbol}\\b`;
  let rgOutput: string;

  try {
    // Try ripgrep first
    rgOutput = execSync(
      `rg --no-heading --line-number --column --type py "${pattern}" "${projectRoot}"`,
      {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      }
    );
  } catch (e: unknown) {
    const error = e as { stdout?: string; status?: number };
    if (error.status === 1) {
      // No matches found
      return {
        content: [
          {
            type: 'text' as const,
            text: `No references found for symbol \`${symbol}\``,
          },
        ],
      };
    }
    // Try grep as fallback
    try {
      rgOutput = execSync(
        `grep -rn --include="*.py" -w "${symbol}" "${projectRoot}"`,
        {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30000,
        }
      );
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No references found for symbol \`${symbol}\``,
          },
        ],
      };
    }
  }

  // Parse ripgrep output: file:line:column:text
  const refs: Reference[] = [];
  const lines = rgOutput.trim().split('\n').filter(Boolean);

  for (const outputLine of lines) {
    // Format: /path/to/file.py:10:5:    some code here
    const match = outputLine.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (match) {
      const [, filePath, lineNum, colNum, text] = match;
      refs.push({
        file: filePath,
        line: parseInt(lineNum, 10),
        column: parseInt(colNum, 10),
        text: text.trim(),
        isDefinition: filePath === file && parseInt(lineNum, 10) === line,
      });
    } else {
      // Fallback for grep format: /path/to/file.py:10:    some code here
      const grepMatch = outputLine.match(/^(.+?):(\d+):(.*)$/);
      if (grepMatch) {
        const [, filePath, lineNum, text] = grepMatch;
        refs.push({
          file: filePath,
          line: parseInt(lineNum, 10),
          column: 1,
          text: text.trim(),
          isDefinition: filePath === file && parseInt(lineNum, 10) === line,
        });
      }
    }
  }

  if (refs.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No references found for symbol \`${symbol}\``,
        },
      ],
    };
  }

  // Sort: definition first, then by file and line
  refs.sort((a, b) => {
    if (a.isDefinition && !b.isDefinition) return -1;
    if (!a.isDefinition && b.isDefinition) return 1;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  // Group by file
  const byFile = new Map<string, Reference[]>();
  for (const ref of refs) {
    const list = byFile.get(ref.file) || [];
    list.push(ref);
    byFile.set(ref.file, list);
  }

  let output = `**References** for \`${symbol}\`\n\n`;
  output += `Found ${refs.length} reference(s) in ${byFile.size} file(s):\n\n`;

  for (const [filePath, fileRefs] of byFile) {
    output += `### ${filePath}\n\n`;
    for (const ref of fileRefs) {
      const marker = ref.isDefinition ? ' (definition)' : '';
      output += `- **${ref.line}:${ref.column}**${marker}: \`${ref.text}\`\n`;
    }
    output += '\n';
  }

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
