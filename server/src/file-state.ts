import { FileContext, FileState, SopsFileType } from "./types";

export class FileStateManager {
  private files: Map<string, FileContext> = new Map();

  get(uri: string): FileContext | undefined {
    return this.files.get(uri);
  }

  init(
    uri: string,
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): FileContext {
    const ctx: FileContext = {
      state: FileState.ENCRYPTED,
      uri,
      encryptedFilePath,
      encryptedContent,
      fileType,
    };
    this.files.set(uri, ctx);
    return ctx;
  }

  transition(uri: string, state: FileState): void {
    const ctx = this.files.get(uri);
    if (ctx) ctx.state = state;
  }

  updateEncryptedContent(uri: string, content: string): void {
    const ctx = this.files.get(uri);
    if (ctx) ctx.encryptedContent = content;
  }

  remove(uri: string): void {
    this.files.delete(uri);
  }
}
