import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { findProjectRoot } from '../utils/position.js';

export const diagnosticsSchema = {
  path: z
    .string()
    .describe('Path to a Python file or directory to check'),
};

interface PyrightDiagnostic {
  file: string;
  severity: string;
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rule?: string;
}

interface PyrightOutput {
  version: string;
  time: string;
  generalDiagnostics: PyrightDiagnostic[];
  summary: {
    filesAnalyzed: number;
    errorCount: number;
    warningCount: number;
    informationCount: number;
    timeInSec: number;
  };
}

export async function diagnostics(args: { path: string }) {
  const { path } = args;

  // Determine project root from path
  const projectRoot = findProjectRoot(path);

  // Build pyright command - path can be file or directory
  const target = path;
  const cmd = `pyright "${target}" --outputjson`;

  let output: PyrightOutput;
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      cwd: projectRoot,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    output = JSON.parse(result);
  } catch (e: unknown) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    // pyright returns non-zero exit code if there are errors
    if (error.stdout) {
      try {
        output = JSON.parse(error.stdout);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error running pyright: ${error.message || 'Unknown error'}`,
            },
          ],
        };
      }
    } else {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error running pyright: ${error.message || 'Unknown error'}\n\nMake sure pyright is installed: npm install -g pyright`,
          },
        ],
      };
    }
  }

  const diags = output.generalDiagnostics || [];
  const summary = output.summary;

  if (diags.length === 0) {
    let text = `**No issues found**\n\n`;
    text += `- Files analyzed: ${summary.filesAnalyzed}\n`;
    text += `- Time: ${summary.timeInSec}s`;
    return {
      content: [{ type: 'text' as const, text }],
    };
  }

  // Group by file
  const byFile = new Map<string, PyrightDiagnostic[]>();
  for (const diag of diags) {
    const list = byFile.get(diag.file) || [];
    list.push(diag);
    byFile.set(diag.file, list);
  }

  let text = `**Diagnostics Summary**\n\n`;
  text += `- Errors: ${summary.errorCount}\n`;
  text += `- Warnings: ${summary.warningCount}\n`;
  text += `- Information: ${summary.informationCount}\n`;
  text += `- Files analyzed: ${summary.filesAnalyzed}\n`;
  text += `- Time: ${summary.timeInSec}s\n\n`;

  text += `---\n\n`;

  for (const [filePath, fileDiags] of byFile) {
    text += `### ${filePath}\n\n`;
    for (const diag of fileDiags) {
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const rule = diag.rule ? ` (${diag.rule})` : '';
      const icon = diag.severity === 'error' ? '❌' : diag.severity === 'warning' ? '⚠️' : 'ℹ️';
      text += `- ${icon} **${diag.severity}** at ${line}:${col}${rule}\n`;
      text += `  ${diag.message}\n\n`;
    }
  }

  return {
    content: [{ type: 'text' as const, text }],
  };
}
