import { FileContext, FileState, SopsFileType } from "./types";

/**
 * Manages state for SOPS-managed files.
 * Keyed by the decrypted sidecar file's URI (the file open in the editor).
 */
export class FileStateManager {
  private files: Map<string, FileContext> = new Map();

  get(decryptedUri: string): FileContext | undefined {
    return this.files.get(decryptedUri);
  }

  init(
    decryptedUri: string,
    encryptedFilePath: string,
    encryptedContent: string,
    decryptedFilePath: string,
    fileType: SopsFileType
  ): FileContext {
    const ctx: FileContext = {
      state: FileState.DECRYPTED,
      encryptedFilePath,
      encryptedContent,
      decryptedFilePath,
      fileType,
    };
    this.files.set(decryptedUri, ctx);
    return ctx;
  }

  transition(decryptedUri: string, state: FileState): void {
    const ctx = this.files.get(decryptedUri);
    if (ctx) ctx.state = state;
  }

  updateEncryptedContent(decryptedUri: string, content: string): void {
    const ctx = this.files.get(decryptedUri);
    if (ctx) ctx.encryptedContent = content;
  }

  remove(decryptedUri: string): void {
    this.files.delete(decryptedUri);
  }
}
