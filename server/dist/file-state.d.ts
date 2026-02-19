import { FileContext, FileState, SopsFileType } from "./types";
export declare class FileStateManager {
    private files;
    get(uri: string): FileContext | undefined;
    init(uri: string, encryptedFilePath: string, encryptedContent: string, fileType: SopsFileType): FileContext;
    transition(uri: string, state: FileState): void;
    updateEncryptedContent(uri: string, content: string): void;
    remove(uri: string): void;
}
