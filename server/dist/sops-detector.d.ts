import { SopsFileType } from "./types";
/**
 * Detect if file content is SOPS-encrypted by checking for the sops metadata block.
 */
export declare function isSopsEncrypted(content: string, fileType: SopsFileType): boolean;
/**
 * Determine the SOPS file type from a file URI/path extension.
 */
export declare function detectFileType(uri: string): SopsFileType;
