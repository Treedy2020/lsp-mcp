import { z } from 'zod';
import { getLspClient } from '../lsp-client.js';

export const updateDocumentSchema = {
  file: z.string().describe('Absolute path to the Python file'),
  content: z.string().describe('New content for the file'),
};

export async function updateDocument(args: { file: string; content: string }) {
  console.error(`[updateDocument] Updating ${args.file}`);
  const client = getLspClient();

  await client.updateDocument(args.file, args.content);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Document updated: ${args.file}`,
      },
    ],
  };
}
