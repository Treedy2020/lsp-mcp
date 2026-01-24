import { z } from 'zod';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { findProjectRoot } from '../utils/position.js';

export const renameSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
  newName: z.string().describe('New name for the symbol'),
};

interface RenameEdit {
  file: string;
  line: number;
  column: number;
  endColumn: number;
  oldText: string;
  newText: string;
  lineContent: string;
}

function getSymbolAtPosition(
  filePath: string,
  line: number,
  column: number
): { symbol: string; start: number; end: number } | null {
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
    return symbol.length > 0 ? { symbol, start: start + 1, end: end + 1 } : null;
  } catch {
    return null;
  }
}

export async function rename(args: { file: string; line: number; column: number; newName: string }) {
  const { file, line, column, newName } = args;

  // Get symbol name at position
  const symbolInfo = getSymbolAtPosition(file, line, column);
  if (!symbolInfo) {
    return {
      content: [{ type: 'text' as const, text: 'Could not identify symbol at this position.' }],
    };
  }

  const { symbol: oldName } = symbolInfo;

  if (oldName === newName) {
    return {
      content: [{ type: 'text' as const, text: 'New name is the same as the old name.' }],
    };
  }

  // Find project root
  const projectRoot = findProjectRoot(file);

  // Use ripgrep to find all references in Python files
  const pattern = `\\b${oldName}\\b`;
  let rgOutput: string;

  try {
    rgOutput = execSync(
      `rg --no-heading --line-number --column --type py "${pattern}" "${projectRoot}"`,
      {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      }
    );
  } catch (e: unknown) {
    const error = e as { status?: number };
    if (error.status === 1) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No references found for symbol \`${oldName}\``,
          },
        ],
      };
    }
    // Try grep as fallback
    try {
      rgOutput = execSync(`grep -rn --include="*.py" -w "${oldName}" "${projectRoot}"`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
      });
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No references found for symbol \`${oldName}\``,
          },
        ],
      };
    }
  }

  // Parse output and create edits
  const edits: RenameEdit[] = [];
  const outputLines = rgOutput.trim().split('\n').filter(Boolean);

  for (const outputLine of outputLines) {
    // Format: /path/to/file.py:10:5:    some code here
    const match = outputLine.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (match) {
      const [, filePath, lineNum, colNum, lineContent] = match;
      const col = parseInt(colNum, 10);
      edits.push({
        file: filePath,
        line: parseInt(lineNum, 10),
        column: col,
        endColumn: col + oldName.length,
        oldText: oldName,
        newText: newName,
        lineContent: lineContent.trim(),
      });
    }
  }

  if (edits.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No references found for symbol \`${oldName}\``,
        },
      ],
    };
  }

  // Group by file
  const byFile = new Map<string, RenameEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) || [];
    list.push(edit);
    byFile.set(edit.file, list);
  }

  let output = `**Rename Preview**\n\n`;
  output += `- Symbol: \`${oldName}\` → \`${newName}\`\n`;
  output += `- Found ${edits.length} occurrence(s) in ${byFile.size} file(s)\n\n`;
  output += `---\n\n`;

  for (const [filePath, fileEdits] of byFile) {
    output += `### ${filePath}\n\n`;
    for (const edit of fileEdits) {
      const preview = edit.lineContent.replace(
        new RegExp(`\\b${oldName}\\b`),
        `~~${oldName}~~ **${newName}**`
      );
      output += `- Line ${edit.line}: ${preview}\n`;
    }
    output += '\n';
  }

  output += `---\n\n`;
  output += `**Note:** This is a preview only. To apply the rename, use your editor's rename feature or run:\n`;
  output += `\`\`\`bash\n`;
  output += `# Using sed (backup recommended)\n`;
  output += `find "${projectRoot}" -name "*.py" -exec sed -i '' 's/\\b${oldName}\\b/${newName}/g' {} +\n`;
  output += `\`\`\``;

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
