# Sidecar open without truncate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the SOPS plaintext sidecar in Zed without truncating it on disk and without marking the new tab dirty.

**Architecture:** Keep `EditSessionRegistry.start()` as the writer of `*.decrypted.*` (`0o600`). Change the LSP open step so `workspace/applyEdit` only asks Zed to create/open that existing file (`CreateFile` with `overwrite: false`, `ignoreIfExists: true`) and does **not** send a follow-up `TextEdit`. Disk is the source of truth; Zed must load the sidecar from disk so the buffer starts clean.

**Tech Stack:** TypeScript / Node 22 (`tsx --test`, esbuild CJS bundle), `vscode-languageserver` 9, Zed 1.19 `workspace/applyEdit` + WASM-embedded `server/dist/index.js`.

**Spec:** `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md` (amend the Start session `applyEdit` bullet). Live evidence: Zed 1.19.2, 2026-09-14, `data-dotdex` / `/tmp/zed-sops-real-test`.

## Global Constraints

- Languages: YAML, JSON, TOML only. Do not attach Plain Text.
- Sidecar files remain mode `0o600`. Do not resurrect `.decrypted~*` as a create path.
- URI conversion: Node `fileURLToPath` / `pathToFileURL`. Do not `uri.slice(7)`.
- `workspace/applyEdit` is still the way to open a sidecar tab. `window/showDocument` stays a last-resort follow-up only if live Zed does not open the tab after `CreateFile` + `ignoreIfExists`.
- If `applyEdit` returns `applied === false` or throws: keep the sidecar on disk and `window/showInformationMessage`: `SOPS: decrypted to <path> — open it to edit.`
- Tests live in `server/test/`, never bundled. Runner: `tsx --test` / `npm test`.
- Do not commit customer repos. Do not save a sidecar on a real customer file during verification (close with Don't Save if the tab is still dirty).
- Do not implement encrypt-new-file, virtual `sops://` docs, hover/definition/completion, or status-bar items.

## Why this shape

Live Zed 1.19 applied `CreateFile(..., { overwrite: true })` by truncating the already-written sidecar to 0 bytes, then applied `TextEdit` only to the **buffer**. Result: empty file on disk, dirty tab, Close always prompts Save, and confirming Save re-encrypts even when the user did not edit.

A protocol-only client (no real CreateFile) left a nonempty sidecar. So the bug is the Zed applyEdit combo, not `registry.start()`.

Opening from disk without overwrite is the only way to get a clean buffer: LSP has no “mark saved” API.

## File structure

| File | Role |
|---|---|
| `server/src/sidecar-open.ts` | Pure `sidecarOpenEdit(uri)` workspace edit + `ensureSidecarContent(path, content)` (`0o600`) |
| `server/test/sidecar-open.test.ts` | Unit tests for the edit payload and the disk-ensure helper |
| `server/src/index.ts` | `openDecryptedFile` uses those helpers; drop `TextEdit` / `CreateFile` overwrite |
| `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md` | Amend Start session step 4 to match the new applyEdit |
| `server/dist/index.js` | Rebuild bundle (embedded by WASM) |

Do not change `edit-session.ts` encrypt/close behavior. `start()` already writes the sidecar before `openDecryptedFile`.

---

### Task 1: Sidecar open edit + disk ensure (TDD)

**Files:**
- Create: `server/src/sidecar-open.ts`
- Create: `server/test/sidecar-open.test.ts`

**Interfaces:**
- Consumes: `vscode-languageserver` `CreateFile`; Node `fs/promises`
- Produces:
  - `export function sidecarOpenEdit(decryptedUri: string): { documentChanges: ReturnType<typeof CreateFile.create>[] }`
  - `export async function ensureSidecarContent(filePath: string, content: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `server/test/sidecar-open.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { CreateFile } from "vscode-languageserver/node";
import { ensureSidecarContent, sidecarOpenEdit } from "../src/sidecar-open";
import { makeTempDir, writeFile } from "./helpers";

describe("sidecarOpenEdit", () => {
  it("asks Zed to create/open without overwrite and without a TextEdit", () => {
    const uri = "file:///tmp/secrets.decrypted.yaml";
    const edit = sidecarOpenEdit(uri);
    assert.equal(edit.documentChanges.length, 1);
    const change = edit.documentChanges[0];
    assert.equal(CreateFile.is(change), true);
    assert.equal(change.uri, uri);
    assert.equal(change.options?.overwrite, false);
    assert.equal(change.options?.ignoreIfExists, true);
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

    await writeFile(sidecar, "", 0o600);
    await ensureSidecarContent(sidecar, "plain: true\n");
    assert.equal(await fs.readFile(sidecar, "utf-8"), "plain: true\n");
  });

  it("does not rewrite when disk already matches", async () => {
    const dir = await makeTempDir();
    const sidecar = path.join(dir, "secrets.decrypted.yaml");
    await ensureSidecarContent(sidecar, "plain: true\n");
    const before = (await fs.stat(sidecar)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await ensureSidecarContent(sidecar, "plain: true\n");
    const after = (await fs.stat(sidecar)).mtimeMs;
    assert.equal(after, before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd server && npx tsx --test test/sidecar-open.test.ts
```

Expected: FAIL with `Cannot find module '../src/sidecar-open'` (or missing exports).

- [ ] **Step 3: Write the minimal module**

Create `server/src/sidecar-open.ts`:

```typescript
import * as fs from "fs/promises";
import { CreateFile } from "vscode-languageserver/node";

export function sidecarOpenEdit(decryptedUri: string): {
  documentChanges: ReturnType<typeof CreateFile.create>[];
} {
  return {
    documentChanges: [
      CreateFile.create(decryptedUri, {
        overwrite: false,
        ignoreIfExists: true,
      }),
    ],
  };
}

export async function ensureSidecarContent(
  filePath: string,
  content: string
): Promise<void> {
  let onDisk: string | null = null;
  try {
    onDisk = await fs.readFile(filePath, "utf-8");
  } catch {
    onDisk = null;
  }
  if (onDisk === content) return;
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd server && npx tsx --test test/sidecar-open.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/sidecar-open.ts server/test/sidecar-open.test.ts
git commit -m "$(cat <<'EOF'
test: cover sidecar open edit that does not truncate disk

Add sidecarOpenEdit (CreateFile ignoreIfExists, no TextEdit) and
ensureSidecarContent so the LSP can open a pre-written sidecar
without Zed emptying it.
EOF
)"
```

---

### Task 2: Wire `openDecryptedFile` and amend the spec

**Files:**
- Modify: `server/src/index.ts` (`openDecryptedFile` ~lines 143–176; drop unused `TextDocumentEdit` / `TextEdit` / `Range` / `Position` imports if they become unused)
- Modify: `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md` (Start session step 4, ~line 210)

**Interfaces:**
- Consumes: `sidecarOpenEdit`, `ensureSidecarContent`
- Produces: `openDecryptedFile` still `Promise<boolean>`; same fallback message on failure

- [ ] **Step 1: Replace `openDecryptedFile`**

In `server/src/index.ts`, add:

```typescript
import { ensureSidecarContent, sidecarOpenEdit } from "./sidecar-open";
```

Replace `openDecryptedFile` with:

```typescript
async function openDecryptedFile(
  decryptedUri: string,
  decryptedFilePath: string,
  content: string
): Promise<boolean> {
  try {
    await ensureSidecarContent(decryptedFilePath, content);
    const result = await connection.workspace.applyEdit(
      sidecarOpenEdit(decryptedUri)
    );
    return result.applied;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
    return false;
  }
}
```

Remove unused imports (`TextDocumentEdit`, `TextEdit`, `Range`, `Position`, `OptionalVersionedTextDocumentIdentifier`, `CreateFile`) only if nothing else in the file uses them. Keep `Range` / `Position` if diagnostics still use them (`line0Range`).

Do not change `startEditSession` call sites: they already pass disk plaintext / existing sidecar text.

- [ ] **Step 2: Amend the spec bullet**

In `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md`, replace Start session step 4:

Old:

```
4. `applyEdit`: `CreateFile` (`overwrite: true`) + full-document `TextEdit` with plaintext. If `applied === false` or the call throws, keep the sidecar and `window/showInformationMessage`: `SOPS: decrypted to <path> — open it to edit.`
```

New:

```
4. Ensure the sidecar on disk already contains the plaintext (`0o600`). `applyEdit`: `CreateFile` with `overwrite: false` and `ignoreIfExists: true` only — no `TextEdit`. Zed 1.19 truncates on `overwrite: true` and applies `TextEdit` to the buffer only, which leaves a 0-byte sidecar and a dirty tab. If `applied === false` or the call throws, keep the sidecar and `window/showInformationMessage`: `SOPS: decrypted to <path> — open it to edit.`
```

Also update the Constraints line that currently says `CreateFile` is the open mechanism (keep that; do not claim `showDocument` is reliable).

- [ ] **Step 3: Typecheck and run the full unit suite**

Run:

```bash
cd server && npx tsc --noEmit && npm test
```

Expected: `tsc` PASS. `npm test` PASS (previous 45 plus the 3 new tests). No remaining `overwrite: true` in `server/src/`.

- [ ] **Step 4: Rebuild the bundle**

Run:

```bash
cd server && npm run build
```

Expected: `server/dist/index.js` rebuilt. Grep the bundle: `ignoreIfExists` present, no `overwrite:!0` / `overwrite: true` in the `openDecryptedFile` path.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/dist/index.js docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md
git commit -m "$(cat <<'EOF'
fix: open SOPS sidecar without truncating it in Zed

Write plaintext to disk first, then applyEdit CreateFile with
ignoreIfExists. Skip TextEdit so the tab loads from disk and
is not dirty on open.
EOF
)"
```

---

### Task 3: Rebuild WASM and verify on real Zed

**Files:**
- Rebuild: `target/wasm32-wasip1/release/zed_sops.wasm` (gitignored)
- Install: `~/Library/Application Support/Zed/extensions/installed/sops/extension.wasm` (user machine, not the repo)

**Interfaces:**
- Consumes: bundled `server/dist/index.js` via `include_str!` in `src/lib.rs`
- Produces: component-format wasm (`\0asm` version `0x1000d`), not a core module

- [ ] **Step 1: Build a Wasm **component** (not a core module)**

Homebrew `rust-wasm` + `wasm-ld` produces a core module; Zed 1.19 rejects it (`attempted to parse a wasm module with a component parser`) and can fail to reload the extension. Use `wasm-component-ld`:

```bash
export PATH="/opt/homebrew/opt/lld@22/bin:/opt/homebrew/opt/wasm-component-ld/bin:$PATH"
cd /Users/vleonov/.t3/worktrees/zed-sops/t3code-dbab43e0
cargo build --release --target wasm32-wasip1 \
  --config /opt/homebrew/opt/rust-wasm/share/rust-wasm/cargo-config.toml \
  --config 'target.wasm32-wasip1.linker="wasm-component-ld"'
python3 -c "from pathlib import Path; b=Path('target/wasm32-wasip1/release/zed_sops.wasm').read_bytes()[:8]; assert b==b'\\x00asm\\r\\x00\\x01\\x00', b"
```

Expected: `is_component` magic `\0asm\r\x00\x01\x00`. Do not install a core module.

- [ ] **Step 2: Install into the running Zed extension dir**

```bash
cp target/wasm32-wasip1/release/zed_sops.wasm \
  "$HOME/Library/Application Support/Zed/extensions/installed/sops/extension.wasm"
cp extension.toml \
  "$HOME/Library/Application Support/Zed/extensions/installed/sops/extension.toml"
```

Zed reloads on file change. Confirm `~/Library/Logs/Zed/Zed.log` has `reloading 1` **without** `Failed to load extension: sops`. Do **not** send Command Palette keystrokes into the T3 Code window (that previously matched the wrong command and quit Zed).

- [ ] **Step 3: Isolated workspace — auto-edit, disk size, dirty, save, close**

Use copies only (do not dirty customer git):

```text
/tmp/zed-sops-real-test/   # already used; recopy data-dotdex secrets.yaml if needed
  .sops.yaml
  .zed/settings.json       # SOPS_AGE_SSH_PRIVATE_KEY_FILE + sopsPath
  hostgroups/prometheus.d/secrets.yaml   # matches path_regex → auto-edit
  outside/secrets.yaml                   # no auto-edit
```

Open `zed -n /tmp/zed-sops-real-test` then the in-scope secrets file. Wait for sidecar.

Pass if all of:
1. `hostgroups/prometheus.d/secrets.decrypted.yaml` exists, size **> 0**, mode `0o600`, no `ENC[`.
2. Sidecar tab is **not** dirty (no Save dialog on File → Close Editor).
3. Close Editor deletes the sidecar.
4. Re-open in-scope file, File → Save: ciphertext hash changes, still has `sops:` / `ENC[`, `sops -d` succeeds. Then Close Editor deletes sidecar.
5. Open `outside/secrets.yaml`: no sidecar, status `SOPS encrypted`.
6. Ciphertext of the customer original is never opened with Save confirmed.

- [ ] **Step 4: If the tab does not auto-open**

If disk sidecar is nonempty but no tab appears: `ignoreIfExists` no-op’d. Then, in the same `openDecryptedFile` `try` after `applyEdit`, add:

```typescript
await connection.window.showDocument({
  uri: decryptedUri,
  external: false,
  takeFocus: true,
});
```

Wrap in its own try/catch; on failure keep the existing information message. Re-run Step 3. Do not bring back `overwrite: true` or `TextEdit`.

- [ ] **Step 5: Real customer file, no save**

Open `/Users/vleonov/Documents/projects/customers/data-dotdex/hostgroups/prometheus.d/secrets.yaml`. Confirm sidecar appears with size > 0. Close Editor (no Save). Confirm `git status` clean in `data-dotdex` and the July ciphertext mtime/size unchanged.

- [ ] **Step 6: Commit only if Step 4 changed source**

If `showDocument` was added:

```bash
git add server/src/index.ts server/dist/index.js
git commit -m "$(cat <<'EOF'
fix: fall back to showDocument when CreateFile does not open the sidecar

Zed may no-op CreateFile with ignoreIfExists on an existing file.
Keep overwrite off so the on-disk plaintext is never truncated.
EOF
)"
```

If Step 3 passed without `showDocument`, no extra commit.

---

## Verification (done when all of these are true)

- `cd server && npx tsc --noEmit && npm test` — 0 failures.
- `server/src/index.ts` `openDecryptedFile` has no `overwrite: true` and no `TextEdit`.
- Live Zed: sidecar on disk nonempty at open; Close without Save prompt; Save still re-encrypts; customer `data-dotdex` git clean.
- No commits in `/Users/vleonov/Documents/projects/customers`.
