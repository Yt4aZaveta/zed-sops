export enum FileState {
  DECRYPTED = "decrypted",
  ENCRYPTING = "encrypting",
}

export type SopsFileType = "yaml" | "json" | "ini" | "binary";

export interface FileContext {
  state: FileState;
  encryptedFilePath: string;
  encryptedContent: string;
  decryptedFilePath: string;
  fileType: SopsFileType;
}

export interface SopsConfig {
  sopsPath: string;
  env: Record<string, string>;
}

export interface SopsSettings {
  sopsPath: string;
  env: Record<string, string>;
  autoEdit: boolean;
  autoEditAll: boolean;
  keyFile: string;
  stateDir: string;
  timeoutMs: number;
}

export const DEFAULT_SOPS_SETTINGS: SopsSettings = {
  sopsPath: "sops",
  env: {},
  autoEdit: true,
  autoEditAll: false,
  keyFile: "",
  stateDir: "",
  timeoutMs: 60_000,
};

export function parseSopsSettings(
  raw: unknown,
  defaults: SopsSettings = DEFAULT_SOPS_SETTINGS
): SopsSettings {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const env =
    obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)
      ? Object.fromEntries(
          Object.entries(obj.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : { ...defaults.env };
  const keyFile =
    typeof obj.keyFile === "string" ? obj.keyFile : defaults.keyFile;
  if (obj.env === undefined && env.SOPS_AGE_SSH_PRIVATE_KEY_FILE === defaults.keyFile) {
    delete env.SOPS_AGE_SSH_PRIVATE_KEY_FILE;
  }
  const mergedEnv = { ...env };
  if (
    keyFile.length > 0 &&
    typeof mergedEnv.SOPS_AGE_SSH_PRIVATE_KEY_FILE !== "string"
  ) {
    mergedEnv.SOPS_AGE_SSH_PRIVATE_KEY_FILE = keyFile;
  }
  return {
    sopsPath:
      typeof obj.sopsPath === "string" && obj.sopsPath.length > 0
        ? obj.sopsPath
        : defaults.sopsPath,
    env: mergedEnv,
    autoEdit: typeof obj.autoEdit === "boolean" ? obj.autoEdit : defaults.autoEdit,
    autoEditAll:
      typeof obj.autoEditAll === "boolean" ? obj.autoEditAll : defaults.autoEditAll,
    keyFile,
    stateDir:
      typeof obj.stateDir === "string" ? obj.stateDir : defaults.stateDir,
    timeoutMs:
      typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
        ? obj.timeoutMs
        : defaults.timeoutMs,
  };
}

export interface SopsRunnerLike {
  decrypt(filePath: string, fileType: SopsFileType): Promise<string>;
  reEncryptStaged(filePath: string, expectedCiphertext: string, plaintext: string, fileType: SopsFileType): Promise<string>;
}

export interface SidecarOwner { pid: number; nonce: string; }
export interface SidecarRecord {
  schema: 1;
  encryptedPath: string;
  sidecarPath: string;
  encryptedSha256: string;
  plaintextSha256: string;
  owner: SidecarOwner;
  createdAt: string;
}
export interface SidecarLease { lockDir: string; record: SidecarRecord; }
export interface AcquireSidecarInput {
  encryptedPath: string;
  sidecarPath: string;
  plaintext: string;
  encryptedSha256: string;
  plaintextSha256: string;
}
export type SidecarInspection =
  | { kind: "none" }
  | { kind: "owned"; lease: SidecarLease }
  | { kind: "live-foreign"; record: SidecarRecord }
  | { kind: "stale"; record: SidecarRecord; lockDir: string }
  | { kind: "ambiguous"; reason: string };

export interface EditSession {
  state: FileState;
  encryptedFilePath: string;
  encryptedContent: string;
  decryptedFilePath: string;
  decryptedUri: string;
  fileType: SopsFileType;
  pending: string | undefined;
  plaintextSnapshot: string;
  lease: SidecarLease;
}
