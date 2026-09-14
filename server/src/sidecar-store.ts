import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { AcquireSidecarInput, SidecarInspection, SidecarLease, SidecarRecord } from "./types";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

export class SidecarStore {
  constructor(private readonly stateDir: string, private readonly owner: { pid: number; nonce?: string }) {}

  private get sessionsDir() { return path.join(this.stateDir, "sessions"); }
  private canonical(p: string) { return path.resolve(p); }
  private lockPath(encryptedPath: string) { return path.join(this.sessionsDir, `${sha(this.canonical(encryptedPath))}.lock`); }
  private async readRecord(lockDir: string): Promise<SidecarRecord | undefined> {
    try { return JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")) as SidecarRecord; }
    catch (e) { if (errno(e) === "ENOENT") return undefined; throw e; }
  }
  private owns(record: SidecarRecord) { return record.owner.pid === this.owner.pid && record.owner.nonce === this.owner.nonce; }
  private async live(pid: number) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return errno(e) === "EPERM"; }
  }
  private async valid(record: SidecarRecord, encryptedPath: string) {
    let canonicalPath: string;
    try { canonicalPath = await fs.realpath(encryptedPath); } catch { canonicalPath = this.canonical(encryptedPath); }
    return record?.schema === 1 && this.canonical(record.encryptedPath) === this.canonical(canonicalPath) && typeof record.sidecarPath === "string" && record.owner && typeof record.owner.pid === "number" && typeof record.owner.nonce === "string";
  }

  async inspect(encryptedPath: string): Promise<SidecarInspection> {
    const lockDir = this.lockPath(encryptedPath);
    let record: SidecarRecord | undefined;
    try { record = await this.readRecord(lockDir); }
    catch { return { kind: "ambiguous", reason: "cannot read owner record" }; }
    if (!record) return { kind: "none" };
    if (!(await this.valid(record, encryptedPath))) return { kind: "ambiguous", reason: "owner record does not match canonical paths" };
    try { await fs.access(record.sidecarPath); } catch { return { kind: "ambiguous", reason: "owned sidecar is absent" }; }
    if (this.owns(record)) return { kind: "owned", lease: { lockDir, record } };
    return (await this.live(record.owner.pid)) ? { kind: "live-foreign", record } : { kind: "stale", record, lockDir };
  }

  async acquire(input: AcquireSidecarInput): Promise<SidecarLease> {
    await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDir, 0o700).catch(() => {});
    await fs.chmod(this.sessionsDir, 0o700);
    const lockDir = this.lockPath(input.encryptedPath);
    try { await fs.mkdir(lockDir, { mode: 0o700 }); } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
      const inspection = await this.inspect(input.encryptedPath);
      if (inspection.kind === "live-foreign") throw new Error("SOPS: file is already edited by another SOPS session.");
      if (inspection.kind === "owned") throw new Error("SOPS: file is already edited by this SOPS session.");
      throw new Error("SOPS: sidecar ownership requires explicit recovery.");
    }
    let created = false;
    try {
      const handle = await fs.open(input.sidecarPath, "wx", 0o600);
      created = true;
      await handle.writeFile(input.plaintext, "utf8"); await handle.sync(); await handle.chmod(0o600); await handle.close();
      const record: SidecarRecord = { schema: 1, encryptedPath: await fs.realpath(input.encryptedPath), sidecarPath: this.canonical(input.sidecarPath), encryptedSha256: input.encryptedSha256, plaintextSha256: input.plaintextSha256, owner: { pid: this.owner.pid, nonce: this.owner.nonce ?? randomUUID() }, createdAt: new Date().toISOString() };
      const tmp = path.join(lockDir, "owner.json.tmp");
      await fs.writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 }); await fs.rename(tmp, path.join(lockDir, "owner.json"));
      return { lockDir, record };
    } catch (e) {
      if (created) await fs.unlink(input.sidecarPath).catch(() => {});
      await fs.rmdir(lockDir).catch(() => {});
      if (errno(e) === "EEXIST") throw new Error(`SOPS: ${input.sidecarPath} already exists and is not owned by this SOPS session.`);
      throw e;
    }
  }

  async claimStale(record: SidecarRecord, lockDir: string): Promise<SidecarLease> {
    if (record.encryptedPath !== this.canonical(record.encryptedPath)) throw new Error("SOPS: invalid stale owner record");
    const recoveryDir = `${lockDir}.stale-${randomUUID()}`;
    await fs.rename(lockDir, recoveryDir);
    await fs.mkdir(lockDir, { mode: 0o700 });
    const next: SidecarRecord = { ...record, owner: { pid: this.owner.pid, nonce: this.owner.nonce ?? randomUUID() }, createdAt: new Date().toISOString() };
    await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    await fs.rm(recoveryDir, { recursive: true, force: true });
    return { lockDir, record: next };
  }

  private async checked(lease: SidecarLease) {
    const current = await this.readRecord(lease.lockDir);
    if (!current || !this.owns(current) || current.owner.nonce !== lease.record.owner.nonce) throw new Error("SOPS: sidecar ownership changed.");
    return current;
  }
  async updateHashes(lease: SidecarLease, encryptedSha256: string, plaintextSha256: string): Promise<void> {
    const current = await this.checked(lease); const next = { ...current, encryptedSha256, plaintextSha256 };
    const tmp = path.join(lease.lockDir, "owner.json.tmp"); await fs.writeFile(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 }); await fs.rename(tmp, path.join(lease.lockDir, "owner.json")); lease.record = next;
  }
  async release(lease: SidecarLease, deleteSidecar: boolean): Promise<void> {
    await this.checked(lease);
    if (deleteSidecar) await fs.unlink(lease.record.sidecarPath).catch((e) => { if (errno(e) !== "ENOENT") throw e; });
    await fs.rm(lease.lockDir, { recursive: true, force: true });
  }
}
