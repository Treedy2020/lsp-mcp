import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';
import { toPosition } from '../utils/position.js';
import { MarkupContent } from 'vscode-languageserver-protocol';

export const signatureHelpSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  line: z.number().int().positive().describe('Line number (1-based)'),
  column: z.number().int().positive().describe('Column number (1-based)'),
};

export async function signatureHelp(args: { file: string; line: number; column: number }) {
  const client = getLspClient();
  const position = toPosition(args.line, args.column);

  const result = await client.signatureHelp(args.file, position);

  if (!result || result.signatures.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No signature help available at this position.' }],
    };
  }

  let output = `**Signature Help** at ${args.file}:${args.line}:${args.column}\n\n`;

  const activeIndex = result.activeSignature ?? 0;
  const activeParam = result.activeParameter ?? 0;

  for (let i = 0; i < result.signatures.length; i++) {
    const sig = result.signatures[i];
    const isActive = i === activeIndex;

    output += `${isActive ? '→ ' : '  '}**${sig.label}**\n`;

    if (sig.documentation) {
      const doc =
        typeof sig.documentation === 'string'
          ? sig.documentation
          : (sig.documentation as MarkupContent).value;
      output += `  ${doc}\n`;
    }

    if (sig.parameters && sig.parameters.length > 0) {
      output += `\n  Parameters:\n`;
      for (let j = 0; j < sig.parameters.length; j++) {
        const param = sig.parameters[j];
        const isActiveParam = isActive && j === activeParam;
        const label =
          typeof param.label === 'string'
            ? param.label
            : sig.label.slice(param.label[0], param.label[1]);

        output += `  ${isActiveParam ? '→ ' : '  '}${label}`;

        if (param.documentation) {
          const paramDoc =
            typeof param.documentation === 'string'
              ? param.documentation
              : (param.documentation as MarkupContent).value;
          output += ` - ${paramDoc}`;
        }
        output += '\n';
      }
    }
    output += '\n';
  }

  return {
    content: [{ type: 'text' as const, text: output }],
  };
}
