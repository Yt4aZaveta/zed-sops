import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { SidecarStore } from "../src/sidecar-store";
import { makeTempDir, writeFile } from "./helpers";

const hashes = {
  encryptedSha256: "e".repeat(64),
  plaintextSha256: "p".repeat(64),
};

async function fixture(nonce = "owner-a") {
  const root = await makeTempDir();
  const stateDir = path.join(root, "state");
  const encryptedPath = path.join(root, "secrets.yaml");
  const sidecarPath = path.join(root, ".decrypted.secrets.yaml");
  await writeFile(encryptedPath, "cipher\n", 0o600);
  const store = new SidecarStore(stateDir, { pid: process.pid, nonce });
  return { root, stateDir, encryptedPath, sidecarPath, store };
}

describe("SidecarStore", () => {
  it("creates a new sidecar exclusively with private state modes", async () => {
    const f = await fixture();
    const lease = await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "plain\n");
    assert.equal((await fs.stat(f.sidecarPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.stateDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.dirname(lease.lockDir))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(lease.lockDir)).mode & 0o777, 0o700);
    assert.equal(lease.record.owner.nonce, "owner-a");
  });

  it("uses the canonical encrypted path for the lock key", async () => {
    const f = await fixture();
    const viaDots = path.join(f.root, "nested", "..", "secrets.yaml");
    const lease = await f.store.acquire({
      encryptedPath: viaDots,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    assert.equal(lease.record.encryptedPath, await fs.realpath(f.encryptedPath));
    assert.match(path.basename(lease.lockDir), /^[a-f0-9]{64}\.lock$/);
  });

  it("leaves a pre-existing unowned sidecar byte-for-byte unchanged", async () => {
    const f = await fixture();
    await writeFile(f.sidecarPath, "user-owned\n", 0o600);
    await assert.rejects(
      () => f.store.acquire({
        encryptedPath: f.encryptedPath,
        sidecarPath: f.sidecarPath,
        plaintext: "plain\n",
        ...hashes,
      }),
      /already exists and is not owned by this SOPS session/
    );
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "user-owned\n");
  });

  it("blocks a second live owner", async () => {
    const f = await fixture("owner-a");
    await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    const second = new SidecarStore(f.stateDir, {
      pid: process.pid,
      nonce: "owner-b",
    });
    const inspection = await second.inspect(f.encryptedPath);
    assert.equal(inspection.kind, "live-foreign");
    await assert.rejects(
      () => second.acquire({
        encryptedPath: f.encryptedPath,
        sidecarPath: f.sidecarPath,
        plaintext: "replacement\n",
        ...hashes,
      }),
      /already edited by another SOPS session/
    );
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "plain\n");
  });

  it("claims a stale owner only after an explicit claim call", async () => {
    const f = await fixture("old-owner");
    const lease = await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "recovery\n",
      ...hashes,
    });
    const record = {
      ...lease.record,
      owner: { pid: 2_147_483_647, nonce: "dead-owner" },
    };
    await fs.writeFile(
      path.join(lease.lockDir, "owner.json"),
      JSON.stringify(record),
      { mode: 0o600 }
    );
    const next = new SidecarStore(f.stateDir, {
      pid: process.pid,
      nonce: "new-owner",
    });
    const inspection = await next.inspect(f.encryptedPath);
    assert.equal(inspection.kind, "stale");
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "recovery\n");
    assert.ok(inspection.kind === "stale");
    const claimed = await next.claimStale(inspection.record, inspection.lockDir);
    assert.equal(claimed.record.owner.nonce, "new-owner");
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "recovery\n");
  });

  it("reports malformed owner records as ambiguous", async () => {
    const f = await fixture();
    const lease = await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    await fs.writeFile(path.join(lease.lockDir, "owner.json"), "{bad", "utf8");
    const inspection = await new SidecarStore(f.stateDir, {
      pid: process.pid,
      nonce: "new-owner",
    }).inspect(f.encryptedPath);
    assert.equal(inspection.kind, "ambiguous");
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "plain\n");
  });

  it("release and hash updates refuse a nonce mismatch", async () => {
    const f = await fixture();
    const lease = await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    const changed = {
      ...lease.record,
      owner: { pid: process.pid, nonce: "different-owner" },
    };
    await fs.writeFile(
      path.join(lease.lockDir, "owner.json"),
      JSON.stringify(changed),
      { mode: 0o600 }
    );
    await assert.rejects(
      () => f.store.updateHashes(lease, "n".repeat(64), "q".repeat(64)),
      /ownership changed/
    );
    await assert.rejects(() => f.store.release(lease, true), /ownership changed/);
    assert.equal(await fs.readFile(f.sidecarPath, "utf8"), "plain\n");
    const stored = JSON.parse(
      await fs.readFile(path.join(lease.lockDir, "owner.json"), "utf8")
    );
    assert.equal(stored.encryptedSha256, hashes.encryptedSha256);
  });

  it("updates hashes durably for the current owner", async () => {
    const f = await fixture();
    const lease = await f.store.acquire({
      encryptedPath: f.encryptedPath,
      sidecarPath: f.sidecarPath,
      plaintext: "plain\n",
      ...hashes,
    });
    const encryptedSha256 = "a".repeat(64);
    const plaintextSha256 = "b".repeat(64);
    await f.store.updateHashes(lease, encryptedSha256, plaintextSha256);
    const stored = JSON.parse(
      await fs.readFile(path.join(lease.lockDir, "owner.json"), "utf8")
    );
    assert.equal(stored.encryptedSha256, encryptedSha256);
    assert.equal(stored.plaintextSha256, plaintextSha256);
    assert.equal(lease.record.encryptedSha256, encryptedSha256);
  });

  it("does not scan or delete unrelated decrypted-looking files", async () => {
    const f = await fixture();
    const unrelated = path.join(f.root, ".decrypted.unrelated.yaml");
    await writeFile(unrelated, "keep\n", 0o600);
    assert.deepEqual(await f.store.inspect(f.encryptedPath), { kind: "none" });
    assert.equal(await fs.readFile(unrelated, "utf8"), "keep\n");
  });
});
