import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { EditSessionRegistry } from "../src/edit-session";
import { FileState, SopsRunnerLike } from "../src/types";
import { getDecryptedPath } from "../src/sops-detector";
import { makeTempDir, writeFile } from "./helpers";

const SOPS_YAML = "hello: ENC[AES256_GCM,data:x]\nsops:\n    version: 3.9.0\n";

function mockRunner(overrides: Partial<SopsRunnerLike> = {}): SopsRunnerLike & {
  decryptCalls: number;
  reEncryptCalls: string[];
} {
  const state = { decryptCalls: 0, reEncryptCalls: [] as string[] };
  return {
    decryptCalls: 0,
    reEncryptCalls: [],
    async decrypt() {
      state.decryptCalls += 1;
      this.decryptCalls = state.decryptCalls;
      return "plain: true\n";
    },
    async reEncrypt(_filePath: string, plaintext: string) {
      state.reEncryptCalls.push(plaintext);
      this.reEncryptCalls = state.reEncryptCalls;
    },
    ...overrides,
  };
}

describe("EditSessionRegistry.start", () => {
  it("writes sidecar 0o600 and records the ciphertext snapshot", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const { session, plaintext } = await registry.start(enc, SOPS_YAML, "yaml");
    assert.equal(plaintext, "plain: true\n");
    assert.equal(session.encryptedContent, SOPS_YAML);
    assert.equal(session.decryptedFilePath, getDecryptedPath(enc));
    assert.equal(session.state, FileState.DECRYPTED);
    const stat = await fs.stat(session.decryptedFilePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(session.decryptedFilePath, "utf-8"), plaintext);
    assert.equal(runner.decryptCalls, 1);
  });

  it("is idempotent: second start does not decrypt again", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const first = await registry.start(enc, SOPS_YAML, "yaml");
    const second = await registry.start(enc, SOPS_YAML, "yaml");
    assert.equal(runner.decryptCalls, 1);
    assert.equal(second.session.decryptedFilePath, first.session.decryptedFilePath);
  });

  it("refuses to overwrite a sidecar whose companion is not SOPS ciphertext", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, "hello: world\n");
    await writeFile(sidecar, "user file\n");
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    await assert.rejects(
      () => registry.start(enc, "hello: world\n", "yaml"),
      /already exists and is not a SOPS sidecar/
    );
    assert.equal(await fs.readFile(sidecar, "utf-8"), "user file\n");
    assert.equal(runner.decryptCalls, 0);
  });
});

describe("EditSessionRegistry.save", () => {
  it("coalesces two overlapping saves to the latest plaintext", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const runner = mockRunner({
      async reEncrypt(_filePath: string, plaintext: string) {
        started += 1;
        if (started === 1) await gate;
        runner.reEncryptCalls.push(plaintext);
      },
    });
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    const uri = session.decryptedUri;
    const first = registry.save(uri, "first\n");
    while (started === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const second = registry.save(uri, "second\n");
    release();
    await Promise.all([first, second]);
    assert.ok(runner.reEncryptCalls.length === 1 || runner.reEncryptCalls.length === 2);
    assert.equal(runner.reEncryptCalls[runner.reEncryptCalls.length - 1], "second\n");
  });

  it("aborts stale ciphertext without calling reEncrypt", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await writeFile(enc, SOPS_YAML + "# changed\n");
    await assert.rejects(
      () => registry.save(session.decryptedUri, "plain\n"),
      /changed on disk; not re-encrypting/
    );
    assert.deepEqual(runner.reEncryptCalls, []);
    assert.equal(session.state, FileState.DECRYPTED);
    await fs.access(session.decryptedFilePath);
  });

  it("restores backup bytes on reEncrypt throw and keeps the sidecar", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner({
      async reEncrypt() {
        await writeFile(enc, "partial-corrupt\n");
        throw new Error("sops failed");
      },
    });
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await assert.rejects(() => registry.save(session.decryptedUri, "plain\n"));
    assert.equal(await fs.readFile(enc, "utf-8"), SOPS_YAML);
    await fs.access(session.decryptedFilePath);
    assert.equal(session.state, FileState.DECRYPTED);
  });
});

describe("EditSessionRegistry.close and orphans", () => {
  it("deletes the sidecar and drops the session", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const registry = new EditSessionRegistry(mockRunner());
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await registry.close(session.decryptedUri);
    await assert.rejects(() => fs.access(session.decryptedFilePath));
    assert.equal(registry.getByDecryptedUri(session.decryptedUri), undefined);
    assert.equal(registry.getByEncryptedPath(enc), undefined);
  });

  it("deletes an on-disk sidecar when it is not in the open set", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, SOPS_YAML);
    await writeFile(sidecar, "orphan\n");
    const registry = new EditSessionRegistry(mockRunner());
    await registry.deleteOrphanSidecars(enc, () => false);
    await assert.rejects(() => fs.access(sidecar));
  });

  it("does not delete an on-disk sidecar that is open", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, SOPS_YAML);
    await writeFile(sidecar, "open\n");
    const registry = new EditSessionRegistry(mockRunner());
    await registry.deleteOrphanSidecars(enc, (p) => p === sidecar);
    assert.equal(await fs.readFile(sidecar, "utf-8"), "open\n");
  });
});
