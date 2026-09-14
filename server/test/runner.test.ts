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

async function writeTransactionalFakeSops(dir: string): Promise<string> {
  const bin = path.join(dir, "transactional-sops");
  await writeFile(
    bin,
    `#!/bin/sh
set -eu
last=""
for arg in "$@"; do last="$arg"; done
printf '%s\\n' "$@" >> "$FAKE_SOPS_LOG"

if [ "\${1:-}" = "--version" ]; then
  echo "sops 3.13.3"
  exit 0
fi

if [ "\${1:-}" = "decrypt" ]; then
  if grep -q '^INVALID' "$last"; then
    echo "invalid staged ciphertext" >&2
    exit 23
  fi
  printf 'plain: true\\n'
  exit 0
fi

if [ "\${FAKE_SOPS_MODE:-success}" = "fail" ]; then
  echo "forced edit failure" >&2
  exit 17
fi

edit_target="$last.plaintext-test"
printf 'old plaintext\\n' > "$edit_target"
"$EDITOR" "$edit_target"

if [ "\${FAKE_SOPS_MODE:-success}" = "stale" ]; then
  printf 'external ciphertext\\n' > "$FAKE_ORIGINAL"
fi
if [ "\${FAKE_SOPS_MODE:-success}" = "invalid" ]; then
  printf 'INVALID\\n' > "$last"
else
  printf 'value: ENC[AES256_GCM,data:new]\\nsops:\\n    version: 3.13.3\\n' > "$last"
fi
`,
    0o755
  );
  return bin;
}

async function transactionFixture(mode = "success") {
  const dir = await makeTempDir();
  const originalPath = path.join(dir, "secrets.yaml");
  const original = "value: ENC[AES256_GCM,data:old]\nsops:\n    version: 3.13.3\n";
  const logPath = path.join(dir, "sops.log");
  await writeFile(originalPath, original, 0o640);
  const sopsPath = await writeTransactionalFakeSops(dir);
  const runner = new SopsRunner({
    ...DEFAULT_SOPS_SETTINGS,
    sopsPath,
    env: {
      FAKE_SOPS_MODE: mode,
      FAKE_SOPS_LOG: logPath,
      FAKE_ORIGINAL: originalPath,
    },
  });
  return { dir, originalPath, original, logPath, runner };
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

describe("SopsRunner.reEncryptStaged", () => {
  it("runs edit mode on staging and commits validated ciphertext", async () => {
    const f = await transactionFixture();
    const committed = await f.runner.reEncryptStaged(
      f.originalPath,
      f.original,
      "plain: changed\n",
      "yaml"
    );
    const calls = await fs.readFile(f.logPath, "utf8");
    const callLines = calls.split("\n");
    const editTarget = callLines.find((line) => line.includes(".zed-sops-stage-"));
    assert.ok(editTarget);
    assert.notEqual(editTarget, f.originalPath);
    assert.deepEqual(callLines.slice(0, 5), [
      "--input-type",
      "yaml",
      "--output-type",
      "yaml",
      editTarget,
    ]);
    assert.equal(await fs.readFile(f.originalPath, "utf8"), committed);
    assert.match(committed, /ENC\[AES256_GCM/);
    assert.equal((await fs.stat(f.originalPath)).mode & 0o777, 0o640);
    assert.deepEqual(
      (await fs.readdir(f.dir)).filter((name) => name.startsWith(".zed-sops-stage-")),
      []
    );
  });

  for (const testCase of [
    { mode: "fail", pattern: /forced edit failure/ },
    { mode: "invalid", pattern: /invalid staged ciphertext/ },
    { mode: "stale", pattern: /changed on disk; not publishing/ },
  ] as const) {
    it(`leaves the original safe when mode is ${testCase.mode}`, async () => {
      const f = await transactionFixture(testCase.mode);
      await assert.rejects(
        () => f.runner.reEncryptStaged(
          f.originalPath,
          f.original,
          "plain: changed\n",
          "yaml"
        ),
        testCase.pattern
      );
      const onDisk = await fs.readFile(f.originalPath, "utf8");
      if (testCase.mode === "stale") {
        assert.equal(onDisk, "external ciphertext\n");
      } else {
        assert.equal(onDisk, f.original);
      }
      assert.deepEqual(
        (await fs.readdir(f.dir)).filter((name) => name.startsWith(".zed-sops-stage-")),
        []
      );
    });
  }
});
