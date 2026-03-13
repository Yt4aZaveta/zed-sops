import { SopsFileType } from "./types";
/**
 * Detect if file content is SOPS-encrypted by checking for the sops metadata block.
 */
export declare function isSopsEncrypted(content: string, fileType: SopsFileType): boolean;
/**
 * Check if a file path refers to a .decrypted~ sidecar file.
 */
export declare function isDecryptedFile(filePath: string): boolean;
/**
 * Get the .decrypted~ sidecar path for an encrypted file.
 * e.g. /path/to/secrets.yaml → /path/to/.decrypted~secrets.yaml
 */
export declare function getDecryptedPath(encryptedFilePath: string): string;
/**
 * Get the original encrypted file path from a .decrypted~ sidecar path.
 * e.g. /path/to/.decrypted~secrets.yaml → /path/to/secrets.yaml
 */
export declare function getEncryptedPath(decryptedFilePath: string): string;
/**
 * Determine the SOPS file type from a file URI/path extension.
 * Handles both encrypted files and .decrypted~ sidecar files.
 */
export declare function detectFileType(uri: string): SopsFileType;
