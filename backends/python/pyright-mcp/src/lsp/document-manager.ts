import * as fs from 'fs';
import * as path from 'path';
import type { DocumentState } from './types.js';

/**
 * Manages document state and versioning for LSP operations.
 * Tracks which documents are open and their current versions.
 */
export class DocumentManager {
  private documents: Map<string, DocumentState> = new Map();

  /**
   * Convert a file path to a file:// URI
   */
  filePathToUri(filePath: string): string {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    return `file://${absolutePath}`;
  }

  /**
   * Convert a file:// URI back to a file path
   */
  uriToFilePath(uri: string): string {
    if (uri.startsWith('file://')) {
      return uri.slice(7);
    }
    return uri;
  }

  /**
   * Check if a document is currently open
   */
  isDocumentOpen(filePath: string): boolean {
    const uri = this.filePathToUri(filePath);
    return this.documents.has(uri);
  }

  /**
   * Get the current state of a document
   */
  getDocument(filePath: string): DocumentState | undefined {
    const uri = this.filePathToUri(filePath);
    return this.documents.get(uri);
  }

  /**
   * Register a document as open with initial content
   */
  openDocument(filePath: string, content?: string): DocumentState {
    const uri = this.filePathToUri(filePath);

    // Read content from file if not provided
    const actualContent = content ?? fs.readFileSync(filePath, 'utf-8');

    const state: DocumentState = {
      uri,
      version: 1,
      content: actualContent,
      languageId: 'python',
    };

    this.documents.set(uri, state);
    return state;
  }

  /**
   * Update a document's content and increment version
   * Returns the new version number
   */
  updateDocument(filePath: string, newContent: string): number {
    const uri = this.filePathToUri(filePath);
    const existing = this.documents.get(uri);

    if (!existing) {
      // Document wasn't open, open it now
      const state = this.openDocument(filePath, newContent);
      return state.version;
    }

    // Increment version and update content
    existing.version += 1;
    existing.content = newContent;

    return existing.version;
  }

  /**
   * Mark a document as closed
   */
  closeDocument(filePath: string): boolean {
    const uri = this.filePathToUri(filePath);
    return this.documents.delete(uri);
  }

  /**
   * Get all open documents
   */
  getAllOpenDocuments(): DocumentState[] {
    return Array.from(this.documents.values());
  }

  /**
   * Close all documents
   */
  closeAll(): void {
    this.documents.clear();
  }

  /**
   * Get the TextDocumentIdentifier for LSP requests
   */
  getTextDocumentIdentifier(filePath: string): { uri: string } {
    return { uri: this.filePathToUri(filePath) };
  }

  /**
   * Get the TextDocumentItem for didOpen notification
   */
  getTextDocumentItem(filePath: string): {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  } {
    const state = this.getDocument(filePath);
    if (!state) {
      throw new Error(`Document not open: ${filePath}`);
    }

    return {
      uri: state.uri,
      languageId: state.languageId,
      version: state.version,
      text: state.content,
    };
  }

  /**
   * Get the VersionedTextDocumentIdentifier for requests that need version
   */
  getVersionedTextDocumentIdentifier(filePath: string): { uri: string; version: number } {
    const state = this.getDocument(filePath);
    if (!state) {
      throw new Error(`Document not open: ${filePath}`);
    }

    return {
      uri: state.uri,
      version: state.version,
    };
  }
}
