import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { SopsRunner, formatSopsError } from "../src/sops-runner";
import { DEFAULT_SOPS_SETTINGS } from "../src/types";
import { makeTempDir, writeFile } from "./helpers";

async function writeFakeSops(
  dir: string,
  body: string
): Promise<string> {
  const bin = path.join(dir, "sops");
  await writeFile(bin, `#!/bin/sh\n${body}\n`, 0o755);
  return bin;
}

describe("formatSopsError", () => {
  it("prefers trimmed stderr and caps at 800 chars", () => {
    const stderr = `${"x".repeat(900)}\n`;
    const msg = formatSopsError({ stderr });
    assert.equal(msg.length, 800);
    assert.equal(msg, "x".repeat(800));
  });

  it("reports timeout when the process was killed", () => {
    const msg = formatSopsError({ killed: true, message: "killed" }, 50);
    assert.match(msg, /timed out after 50ms/);
  });
});

describe("SopsRunner.verify", () => {
  it("caches ok from sops --version", async () => {
    const dir = await makeTempDir();
    const bin = await writeFakeSops(
      dir,
      `if [ "$1" = "--version" ]; then echo "sops 3.9.0"; exit 0; fi; exit 1`
    );
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
    });
    assert.equal(await runner.verify(), "ok");
    assert.equal(runner.getVerifyStatus(), "ok");
    assert.equal(await runner.verify(), "ok");
  });

  it("caches missing when the binary cannot run", async () => {
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: path.join("/nonexistent", "sops-binary"),
    });
    assert.equal(await runner.verify(), "missing");
    assert.equal(runner.getVerifyStatus(), "missing");
  });
});

describe("SopsRunner.decrypt timeout", () => {
  it("kills a hanging sops and treats it as failure", async () => {
    const dir = await makeTempDir();
    const bin = await writeFakeSops(dir, `sleep 5`);
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
      timeoutMs: 200,
    });
    await assert.rejects(() => runner.decrypt(path.join(dir, "f.yaml"), "yaml"));
  });
});

describe("SopsRunner.reEncrypt EDITOR", () => {
  it("uses SOPS_ZED_CONTENT env and does not interpolate the plaintext path into the script", async () => {
    const dir = await makeTempDir();
    const seen = path.join(dir, "seen.txt");
    const target = path.join(dir, "secrets.yaml");
    await writeFile(target, "cipher\n");
    const bin = await writeFakeSops(
      dir,
      `
echo "EDITOR=$EDITOR" > "${seen}"
echo "CONTENT=$SOPS_ZED_CONTENT" >> "${seen}"
cat "$EDITOR" >> "${seen}"
# emulate sops invoking EDITOR on a temp file
tmp="${dir}/edit-target"
echo old > "$tmp"
"$EDITOR" "$tmp"
cp "$tmp" "$3" 2>/dev/null || true
echo encrypted > "${target}"
`
    );
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
    });
    await runner.reEncrypt(target, "new-plain\n", "yaml");
    const seenText = await fs.readFile(seen, "utf-8");
    assert.match(seenText, /CONTENT=\//);
    assert.match(seenText, /cp "\$SOPS_ZED_CONTENT" "\$1"/);
    assert.doesNotMatch(seenText, /cp "\/tmp\/sops-content-/);
    assert.equal(await fs.readFile(target, "utf-8"), "encrypted\n");
  });
});
