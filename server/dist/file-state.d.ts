import { FileContext, FileState, SopsFileType } from "./types";
/**
 * Manages state for SOPS-managed files.
 * Keyed by the decrypted sidecar file's URI (the file open in the editor).
 */
export declare class FileStateManager {
    private files;
    get(decryptedUri: string): FileContext | undefined;
    init(decryptedUri: string, encryptedFilePath: string, encryptedContent: string, decryptedFilePath: string, fileType: SopsFileType): FileContext;
    transition(decryptedUri: string, state: FileState): void;
    updateEncryptedContent(decryptedUri: string, content: string): void;
    remove(decryptedUri: string): void;
}
