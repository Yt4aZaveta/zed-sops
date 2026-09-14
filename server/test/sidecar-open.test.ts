import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { CreateFile } from "vscode-languageserver/node";
import {
  ensureSidecarContent,
  restoreSidecarAfterOpen,
  sidecarOpenEdit,
} from "../src/sidecar-open";
import { makeTempDir, writeFile } from "./helpers";

describe("sidecarOpenEdit", () => {
  it("uses CreateFile overwrite so Zed opens/focuses the tab, without a TextEdit", () => {
    const uri = "file:///tmp/secrets.decrypted.yaml";
    const edit = sidecarOpenEdit(uri);
    assert.equal(edit.documentChanges.length, 1);
    const change = edit.documentChanges[0];
    assert.equal(CreateFile.is(change), true);
    assert.equal(change.uri, uri);
    assert.equal(change.options?.overwrite, true);
    assert.equal(change.options?.ignoreIfExists, false);
    assert.equal("edits" in change, false);
  });
});

describe("ensureSidecarContent", () => {
  it("writes 0o600 when the file is missing or differs", async () => {
    const dir = await makeTempDir();
    const sidecar = path.join(dir, "secrets.decrypted.yaml");
    await ensureSidecarContent(sidecar, "plain: true\n");
    const stat = await fs.stat(sidecar);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(sidecar, "utf-8"), "plain: true\n");
  });
});

describe("restoreSidecarAfterOpen", () => {
  it("rewrites plaintext after a truncate and bumps mtime", async () => {
    const dir = await makeTempDir();
    const sidecar = path.join(dir, "secrets.decrypted.yaml");
    await writeFile(sidecar, "plain: true\n", 0o600);
    const before = (await fs.stat(sidecar)).mtimeMs;
    await fs.writeFile(sidecar, "", { encoding: "utf-8" });
    await new Promise((r) => setTimeout(r, 20));
    await restoreSidecarAfterOpen(sidecar, "plain: true\n");
    const after = await fs.stat(sidecar);
    assert.equal(await fs.readFile(sidecar, "utf-8"), "plain: true\n");
    assert.equal(after.mode & 0o777, 0o600);
    assert.ok(after.mtimeMs >= before);
    assert.ok(after.size > 0);
  });
});
