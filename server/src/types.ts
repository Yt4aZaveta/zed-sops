export enum FileState {
  /** File is confirmed SOPS-encrypted, not yet decrypted in buffer */
  ENCRYPTED = "encrypted",
  /** Buffer contains decrypted content, user is editing */
  DECRYPTED = "decrypted",
  /** Re-encryption in progress */
  ENCRYPTING = "encrypting",
}

export interface FileContext {
  state: FileState;
  /** URI of the file open in the editor */
  uri: string;
  /** Absolute path to the encrypted file on disk */
  encryptedFilePath: string;
  /** The current encrypted content */
  encryptedContent: string;
  /** File type for sops --input-type/--output-type */
  fileType: SopsFileType;
}

export type SopsFileType = "yaml" | "json" | "ini" | "dotenv" | "binary";

export interface SopsConfig {
  /** Path to the sops binary (default: "sops") */
  sopsPath: string;
  /** Additional environment variables for sops */
  env: Record<string, string>;
}
