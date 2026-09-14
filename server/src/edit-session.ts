import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createHash } from "crypto";
import { getDecryptedPath } from "./sops-detector";
import { SidecarStore } from "./sidecar-store";
import {
  EditSession,
  FileState,
  SopsFileType,
  SopsRunnerLike,
  SidecarLease,
} from "./types";

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createSidecarExclusive(
  filePath: string,
  plaintext: string
): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `SOPS: ${filePath} already exists and is not owned by this SOPS session.`
      );
    }
    throw error;
  }
  let complete = false;
  try {
    await handle.writeFile(plaintext, "utf8");
    await handle.sync();
    const mode = (await handle.stat()).mode & 0o777;
    if (mode !== 0o600) {
      await handle.chmod(0o600);
    }
    complete = true;
  } finally {
    await handle.close().catch(() => {});
    if (!complete) await fs.unlink(filePath).catch(() => {});
  }
}

export class EditSessionRegistry {
  private readonly byEncrypted = new Map<string, EditSession>();
  private readonly byDecryptedUri = new Map<string, EditSession>();
  private readonly byDecryptedPath = new Map<string, EditSession>();

  constructor(private readonly runner: SopsRunnerLike, private readonly sidecars: SidecarStore) {}

  getByDecryptedUri(uri: string): EditSession | undefined {
    return this.byDecryptedUri.get(uri);
  }

  getByDecryptedPath(filePath: string): EditSession | undefined {
    return this.byDecryptedPath.get(path.resolve(filePath));
  }

  getByEncryptedPath(filePath: string): EditSession | undefined {
    return this.byEncrypted.get(path.resolve(filePath));
  }

  lookupDecrypted(uri: string): EditSession | undefined {
    const direct = this.byDecryptedUri.get(uri);
    if (direct) return direct;
    try {
      return this.byDecryptedPath.get(path.resolve(fileURLToPath(uri)));
    } catch {
      return undefined;
    }
  }

  list(): EditSession[] {
    return [...this.byEncrypted.values()];
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

  // `encryptedContent` must be on-disk ciphertext (`fs.readFile`), not an
  // unsaved editor buffer. encryptLoop compares disk to this snapshot.
  async start(
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<{ session: EditSession; plaintext: string }> {
    const resolved = path.resolve(encryptedFilePath);
    const existing = this.byEncrypted.get(resolved);
    if (existing) {
      if (await exists(existing.decryptedFilePath)) {
        const plaintext = await fs.readFile(existing.decryptedFilePath, "utf-8");
        return { session: existing, plaintext };
      }
      await this.sidecars.release(existing.lease, false).catch(() => {});
      this.unindex(existing);
    }

    const plaintext = await this.runner.decrypt(resolved, fileType);
    const decryptedFilePath = getDecryptedPath(resolved);
    const lease = await this.sidecars.acquire({ encryptedPath: resolved, sidecarPath: decryptedFilePath, plaintext, encryptedSha256: sha256(encryptedContent), plaintextSha256: sha256(plaintext) });
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolved,
      encryptedContent,
      decryptedFilePath,
      decryptedUri: filePathToUri(decryptedFilePath),
      fileType,
      pending: undefined,
      plaintextSnapshot: plaintext,
      lease,
    };
    this.index(session);
    return { session, plaintext };
  }

  async adopt(
    lease: SidecarLease,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<EditSession> {
    const resolvedEnc = path.resolve(lease.record.encryptedPath);
    const existing = this.byEncrypted.get(resolvedEnc);
    if (existing) return existing;
    const resolvedDec = path.resolve(lease.record.sidecarPath);
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolvedEnc,
      encryptedContent,
      decryptedFilePath: resolvedDec,
      decryptedUri: filePathToUri(resolvedDec),
      fileType,
      pending: undefined,
      plaintextSnapshot: "",
      lease,
    };
    this.index(session);
    return session;
  }

  async save(decryptedUri: string, plaintext: string): Promise<void> {
    const session = this.lookupDecrypted(decryptedUri);
    if (!session) return;
    if (session.state === FileState.ENCRYPTING) {
      session.pending = plaintext;
      return;
    }
    session.state = FileState.ENCRYPTING;
    try {
      await this.encryptLoop(session, plaintext);
    } catch (error) {
      session.pending = undefined;
      session.state = FileState.DECRYPTED;
      throw error;
    }
  }

  private async encryptLoop(session: EditSession, plaintext: string): Promise<void> {
    let current = plaintext;
    for (;;) {
      const onDisk = await fs.readFile(session.encryptedFilePath, "utf-8");
      if (onDisk !== session.encryptedContent) {
        throw new Error(
          `SOPS: ${session.encryptedFilePath} changed on disk; not re-encrypting.`
        );
      }

      session.encryptedContent = await this.runner.reEncryptStaged(session.encryptedFilePath, session.encryptedContent, current, session.fileType);
      session.plaintextSnapshot = current;
      await this.sidecars.updateHashes(session.lease, sha256(session.encryptedContent), sha256(current));

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
    let session = this.byDecryptedUri.get(decryptedUri);
    if (!session) {
      try {
        session = this.byDecryptedPath.get(
          path.resolve(fileURLToPath(decryptedUri))
        );
      } catch {
        session = undefined;
      }
    }
    if (!session) return;
    await this.sidecars.release(session.lease, true);
    this.unindex(session);
  }
}
