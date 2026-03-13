import * as path from "path";
import { SopsFileType } from "./types";

const DECRYPTED_PREFIX = ".decrypted~";

/**
 * Detect if file content is SOPS-encrypted by checking for the sops metadata block.
 */
export function isSopsEncrypted(content: string, fileType: SopsFileType): boolean {
  try {
    if (fileType === "json") {
      const parsed = JSON.parse(content);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.sops === "object" &&
        typeof parsed.sops.version === "string"
      );
    }

    if (fileType === "yaml") {
      const sopsMatch = content.match(/^sops:\s*$/m);
      if (!sopsMatch) return false;
      const afterSops = content.slice(sopsMatch.index! + sopsMatch[0].length);
      return /^\s+version:\s+/m.test(afterSops);
    }

    if (fileType === "ini") {
      return content.includes("[sops]");
    }

    if (fileType === "dotenv") {
      return content.includes("sops_version=");
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a file path refers to a .decrypted~ sidecar file.
 */
export function isDecryptedFile(filePath: string): boolean {
  return path.basename(filePath).startsWith(DECRYPTED_PREFIX);
}

/**
 * Get the .decrypted~ sidecar path for an encrypted file.
 * e.g. /path/to/secrets.yaml → /path/to/.decrypted~secrets.yaml
 */
export function getDecryptedPath(encryptedFilePath: string): string {
  const dir = path.dirname(encryptedFilePath);
  const name = path.basename(encryptedFilePath);
  return path.join(dir, `${DECRYPTED_PREFIX}${name}`);
}

/**
 * Get the original encrypted file path from a .decrypted~ sidecar path.
 * e.g. /path/to/.decrypted~secrets.yaml → /path/to/secrets.yaml
 */
export function getEncryptedPath(decryptedFilePath: string): string {
  const dir = path.dirname(decryptedFilePath);
  const name = path.basename(decryptedFilePath);
  return path.join(dir, name.slice(DECRYPTED_PREFIX.length));
}

/**
 * Determine the SOPS file type from a file URI/path extension.
 * Handles both encrypted files and .decrypted~ sidecar files.
 */
export function detectFileType(uri: string): SopsFileType {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ini")) return "ini";
  if (lower.endsWith(".env") || lower.includes(".env.")) return "dotenv";
  return "yaml";
}
