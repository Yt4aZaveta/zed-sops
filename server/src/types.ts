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
  timeoutMs: number;
}

export const DEFAULT_SOPS_SETTINGS: SopsSettings = {
  sopsPath: "sops",
  env: {},
  autoEdit: true,
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
      : defaults.env;
  return {
    sopsPath:
      typeof obj.sopsPath === "string" && obj.sopsPath.length > 0
        ? obj.sopsPath
        : defaults.sopsPath,
    env,
    autoEdit: typeof obj.autoEdit === "boolean" ? obj.autoEdit : defaults.autoEdit,
    timeoutMs:
      typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
        ? obj.timeoutMs
        : defaults.timeoutMs,
  };
}

export interface SopsRunnerLike {
  decrypt(filePath: string, fileType: SopsFileType): Promise<string>;
  reEncrypt(filePath: string, plaintext: string, fileType: SopsFileType): Promise<void>;
}

export interface EditSession {
  state: FileState;
  encryptedFilePath: string;
  encryptedContent: string;
  decryptedFilePath: string;
  decryptedUri: string;
  fileType: SopsFileType;
  pending: string | undefined;
}
