import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { EditSessionRegistry } from "../src/edit-session";
import { SidecarStore } from "../src/sidecar-store";
import { FileState, SopsRunnerLike } from "../src/types";
import { getDecryptedPath } from "../src/sops-detector";
import { makeTempDir, writeFile } from "./helpers";

const SOPS_YAML = "hello: ENC[AES256_GCM,data:x]\nsops:\n    version: 3.9.0\n";
function runner(overrides: Partial<SopsRunnerLike> = {}) {
  const calls: string[] = [];
  return { calls, decrypt: async () => "plain: true\n", reEncryptStaged: async (_p: string, _e: string, plain: string) => { calls.push(plain); return SOPS_YAML; }, ...overrides };
}
function registry(dir: string, r: SopsRunnerLike) { return new EditSessionRegistry(r, new SidecarStore(path.join(dir, "state"), { pid: process.pid, nonce: "test-owner" })); }

describe("EditSessionRegistry", () => {
  it("decrypts before exclusive 0600 sidecar creation and accepts empty plaintext", async () => {
    const dir = await makeTempDir(); const enc = path.join(dir, "secrets.yaml"); await writeFile(enc, SOPS_YAML);
    const r = runner({ decrypt: async () => "" }); const { session, plaintext } = await registry(dir, r).start(enc, SOPS_YAML, "yaml");
    assert.equal(plaintext, ""); assert.equal(await fs.readFile(session.decryptedFilePath, "utf8"), ""); assert.equal((await fs.stat(session.decryptedFilePath)).mode & 0o777, 0o600);
  });
  it("preserves an existing sidecar when decrypt fails", async () => {
    const dir = await makeTempDir(); const enc = path.join(dir, "secrets.yaml"); const side = getDecryptedPath(enc); await writeFile(enc, SOPS_YAML); await writeFile(side, "keep\n", 0o600);
    await assert.rejects(() => registry(dir, runner({ decrypt: async () => { throw new Error("missing key"); } })).start(enc, SOPS_YAML, "yaml"), /missing key/); assert.equal(await fs.readFile(side, "utf8"), "keep\n");
  });
  it("supports concurrent sessions and canonical URI save lookup", async () => {
    const dir = await makeTempDir(); const a = path.join(dir, "a.yaml"); const b = path.join(dir, "b.yaml"); await writeFile(a, SOPS_YAML); await writeFile(b, SOPS_YAML);
    const r = runner(); const reg = registry(dir, r); const first = await reg.start(a, SOPS_YAML, "yaml"); const second = await reg.start(b, SOPS_YAML, "yaml");
    assert.equal(reg.list().length, 2); const equivalent = pathToFileURL(path.resolve(first.session.decryptedFilePath)).href.replace(".decrypted", "%2Edecrypted"); assert.equal(reg.lookupDecrypted(equivalent), first.session); await reg.save(equivalent, "changed\n"); assert.equal(r.calls.at(-1), "changed\n"); assert.equal(reg.getByEncryptedPath(b), second.session);
  });
  it("recreates a deleted session sidecar without touching unrelated files", async () => {
    const dir = await makeTempDir(); const enc = path.join(dir, "secrets.yaml"); await writeFile(enc, SOPS_YAML); const unrelated = path.join(dir, ".decrypted.other.yaml"); await writeFile(unrelated, "keep\n", 0o600);
    const reg = registry(dir, runner()); const first = await reg.start(enc, SOPS_YAML, "yaml"); await fs.unlink(first.session.decryptedFilePath); const next = await reg.start(enc, SOPS_YAML, "yaml"); assert.equal(await fs.readFile(next.session.decryptedFilePath, "utf8"), "plain: true\n"); assert.equal(await fs.readFile(unrelated, "utf8"), "keep\n");
  });
  it("closes only the owned sidecar", async () => {
    const dir = await makeTempDir(); const enc = path.join(dir, "secrets.yaml"); await writeFile(enc, SOPS_YAML); const reg = registry(dir, runner()); const { session } = await reg.start(enc, SOPS_YAML, "yaml"); await reg.close(session.decryptedUri); await assert.rejects(() => fs.access(session.decryptedFilePath)); assert.equal(reg.list().length, 0);
  });
  it("keeps the session and ciphertext after staged save failure", async () => {
    const dir = await makeTempDir(); const enc = path.join(dir, "secrets.yaml"); await writeFile(enc, SOPS_YAML); const reg = registry(dir, runner({ reEncryptStaged: async () => { throw new Error("sops failed"); } })); const { session } = await reg.start(enc, SOPS_YAML, "yaml"); await assert.rejects(() => reg.save(session.decryptedUri, "changed\n"), /sops failed/); assert.equal(session.state, FileState.DECRYPTED); assert.equal(await fs.readFile(enc, "utf8"), SOPS_YAML); assert.equal(await fs.readFile(session.decryptedFilePath, "utf8"), "plain: true\n");
  });
});
