import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getDecryptedPath,
  isSopsEncrypted,
  possibleSidecarPaths,
} from "./sops-detector";
import {
  EditSession,
  FileState,
  SopsFileType,
  SopsRunnerLike,
} from "./types";

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSidecar(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export class EditSessionRegistry {
  private readonly byEncrypted = new Map<string, EditSession>();
  private readonly byDecryptedUri = new Map<string, EditSession>();
  private readonly byDecryptedPath = new Map<string, EditSession>();

  constructor(private readonly runner: SopsRunnerLike) {}

  getByDecryptedUri(uri: string): EditSession | undefined {
    return this.byDecryptedUri.get(uri);
  }

  getByDecryptedPath(filePath: string): EditSession | undefined {
    return this.byDecryptedPath.get(path.resolve(filePath));
  }

  getByEncryptedPath(filePath: string): EditSession | undefined {
    return this.byEncrypted.get(path.resolve(filePath));
  }

  private index(session: EditSession): void {
    this.byEncrypted.set(path.resolve(session.encryptedFilePath), session);
    this.byDecryptedUri.set(session.decryptedUri, session);
    this.byDecryptedPath.set(path.resolve(session.decryptedFilePath), session);
  }

  private unindex(session: EditSession): void {
    this.byEncrypted.delete(path.resolve(session.encryptedFilePath));
    this.byDecryptedUri.delete(session.decryptedUri);
    this.byDecryptedPath.delete(path.resolve(session.decryptedFilePath));
  }

  async start(
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<{ session: EditSession; plaintext: string }> {
    const resolved = path.resolve(encryptedFilePath);
    const existing = this.byEncrypted.get(resolved);
    if (existing) {
      let plaintext = "";
      try {
        plaintext = await fs.readFile(existing.decryptedFilePath, "utf-8");
      } catch {
        plaintext = "";
      }
      return { session: existing, plaintext };
    }

    const decryptedFilePath = getDecryptedPath(resolved);
    if (await exists(decryptedFilePath)) {
      const companion = await fs.readFile(resolved, "utf-8").catch(() => "");
      if (!isSopsEncrypted(companion, fileType)) {
        throw new Error(
          `SOPS: ${decryptedFilePath} already exists and is not a SOPS sidecar.`
        );
      }
    }

    const plaintext = await this.runner.decrypt(resolved, fileType);
    await writeSidecar(decryptedFilePath, plaintext);
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolved,
      encryptedContent,
      decryptedFilePath,
      decryptedUri: filePathToUri(decryptedFilePath),
      fileType,
      pending: undefined,
    };
    this.index(session);
    return { session, plaintext };
  }

  async adopt(
    decryptedFilePath: string,
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<EditSession> {
    const resolvedEnc = path.resolve(encryptedFilePath);
    const existing = this.byEncrypted.get(resolvedEnc);
    if (existing) return existing;
    const resolvedDec = path.resolve(decryptedFilePath);
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolvedEnc,
      encryptedContent,
      decryptedFilePath: resolvedDec,
      decryptedUri: filePathToUri(resolvedDec),
      fileType,
      pending: undefined,
    };
    this.index(session);
    return session;
  }

  async save(decryptedUri: string, plaintext: string): Promise<void> {
    const session = this.byDecryptedUri.get(decryptedUri);
    if (!session) return;
    if (session.state === FileState.ENCRYPTING) {
      session.pending = plaintext;
      return;
    }
    session.state = FileState.ENCRYPTING;
    try {
      await this.encryptLoop(session, plaintext);
    } finally {
      if (session.state === FileState.ENCRYPTING) {
        session.state = FileState.DECRYPTED;
      }
    }
  }

  private async encryptLoop(session: EditSession, plaintext: string): Promise<void> {
    let current = plaintext;
    for (;;) {
      const onDisk = await fs.readFile(session.encryptedFilePath, "utf-8");
      if (onDisk !== session.encryptedContent) {
        session.state = FileState.DECRYPTED;
        session.pending = undefined;
        throw new Error(
          `SOPS: ${session.encryptedFilePath} changed on disk; not re-encrypting.`
        );
      }

      const backupPath = path.join(
        os.tmpdir(),
        `sops-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      try {
        await fs.writeFile(backupPath, session.encryptedContent, {
          encoding: "utf-8",
          mode: 0o600,
        });
        await fs.chmod(backupPath, 0o600);
        try {
          await this.runner.reEncrypt(
            session.encryptedFilePath,
            current,
            session.fileType
          );
        } catch (error) {
          await fs.copyFile(backupPath, session.encryptedFilePath);
          session.state = FileState.DECRYPTED;
          session.pending = undefined;
          throw error;
        }
        session.encryptedContent = await fs.readFile(
          session.encryptedFilePath,
          "utf-8"
        );
      } finally {
        await fs.unlink(backupPath).catch(() => {});
      }

      if (session.pending !== undefined) {
        current = session.pending;
        session.pending = undefined;
        continue;
      }
      session.state = FileState.DECRYPTED;
      return;
    }
  }

  async close(decryptedUri: string): Promise<void> {
    const session = this.byDecryptedUri.get(decryptedUri);
    if (!session) return;
    await fs.unlink(session.decryptedFilePath).catch(() => {});
    this.unindex(session);
  }

  async deleteOrphanSidecars(
    encryptedFilePath: string,
    isOpen: (sidecarPath: string) => boolean
  ): Promise<void> {
    for (const sidecar of possibleSidecarPaths(encryptedFilePath)) {
      if (!(await exists(sidecar))) continue;
      if (isOpen(sidecar)) continue;
      if (this.byDecryptedPath.has(path.resolve(sidecar))) continue;
      await fs.unlink(sidecar).catch(() => {});
    }
  }
}
