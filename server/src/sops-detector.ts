import * as path from "path";
import { SopsFileType } from "./types";

const LEGACY_PREFIX = ".decrypted~";
const DOT_PREFIX = ".decrypted.";
const INFIX_SIDECAR_RE = /^(.*)\.decrypted(\.[^.]+)$/;

export function isSopsEncrypted(content: string, fileType: SopsFileType): boolean {
  try {
    if (fileType === "json") {
      const parsed = JSON.parse(content);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.sops === "object" &&
        parsed.sops !== null &&
        typeof parsed.sops.version === "string"
      );
    }

    if (fileType === "yaml") {
      const sopsMatch = content.match(/^sops:\s*$/m);
      if (!sopsMatch || sopsMatch.index === undefined) return false;
      const afterSops = content.slice(sopsMatch.index + sopsMatch[0].length);
      // Require space/tab indent on the version line; \s would also match the
      // newline left after the sops: match and falsely accept column-0 version.
      return /^[ \t]+version:\s+/m.test(afterSops);
    }

    if (fileType === "ini") {
      return content.includes("[sops]");
    }

    // toml is passed as binary; same heuristic
    return (
      content.includes("[sops]") ||
      content.includes("sops.version") ||
      content.includes("ENC[AES256_GCM")
    );
  } catch {
    return false;
  }
}

export function isDecryptedFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return (
    name.startsWith(LEGACY_PREFIX) ||
    name.startsWith(DOT_PREFIX) ||
    INFIX_SIDECAR_RE.test(name)
  );
}

export function getDecryptedPath(encryptedFilePath: string): string {
  return path.join(
    path.dirname(encryptedFilePath),
    `${DOT_PREFIX}${path.basename(encryptedFilePath)}`
  );
}

export function getInfixDecryptedPath(encryptedFilePath: string): string {
  const dir = path.dirname(encryptedFilePath);
  const parsed = path.parse(encryptedFilePath);
  if (parsed.ext !== "") {
    return path.join(dir, `${parsed.name}.decrypted${parsed.ext}`);
  }
  return path.join(dir, `${parsed.base}.decrypted`);
}

export function getLegacyDecryptedPath(encryptedFilePath: string): string {
  return path.join(
    path.dirname(encryptedFilePath),
    `${LEGACY_PREFIX}${path.basename(encryptedFilePath)}`
  );
}

export function getEncryptedPath(decryptedFilePath: string): string {
  const dir = path.dirname(decryptedFilePath);
  const name = path.basename(decryptedFilePath);
  if (name.startsWith(LEGACY_PREFIX)) {
    return path.join(dir, name.slice(LEGACY_PREFIX.length));
  }
  if (name.startsWith(DOT_PREFIX)) {
    return path.join(dir, name.slice(DOT_PREFIX.length));
  }
  const match = name.match(INFIX_SIDECAR_RE);
  if (match) {
    return path.join(dir, `${match[1]}${match[2]}`);
  }
  return decryptedFilePath;
}

export function possibleSidecarPaths(encryptedFilePath: string): string[] {
  return [
    getDecryptedPath(encryptedFilePath),
    getInfixDecryptedPath(encryptedFilePath),
    getLegacyDecryptedPath(encryptedFilePath),
  ];
}

export function detectFileType(filePath: string): SopsFileType {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ini")) return "ini";
  if (lower.endsWith(".toml")) return "binary";
  return "yaml";
}
