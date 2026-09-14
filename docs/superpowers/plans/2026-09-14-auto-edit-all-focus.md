# Auto-edit all + keyFile + sidecar focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in auto-decrypt of every SOPS YAML/JSON/TOML file with a configured key, and focus the plaintext sidecar tab without leaving it empty or dirty.

**Architecture:** Keep decrypt + `0o600` sidecar writes in the LSP. Open the tab with `CreateFile({ overwrite: true })` and **no** `TextEdit` (that is what makes Zed focus the buffer). Immediately rewrite plaintext to disk and bump `mtime` so Zed reloads a clean, non-empty buffer. Add `autoEditAll` (skip `.sops.yaml` matching) and `keyFile` (injected as `SOPS_AGE_SSH_PRIVATE_KEY_FILE` unless `env` already sets it).

**Tech Stack:** TypeScript / Node 22 (`tsx --test`, esbuild CJS bundle), `vscode-languageserver` 9, Zed 1.19 applyEdit + FS reload, WASM-embedded `server/dist/index.js`.

**Spec:** `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md` (amend auto-edit rules, settings example, and the Start session applyEdit bullet). Live evidence: Zed 1.19.2, 2026-09-14 — `showDocument` unhandled; `ignoreIfExists` does not open; empty-buffer + external rewrite reloads clean (no Save dialog).

## Global Constraints

- Languages: YAML, JSON, TOML only. Do not attach Plain Text.
- Sidecar files remain mode `0o600`. Do not create `.decrypted~*`.
- URI conversion: Node `fileURLToPath` / `pathToFileURL`. Do not `uri.slice(7)`.
- Do **not** send `TextEdit` when opening the sidecar. TextEdit dirties the buffer; Zed then refuses to reload from disk.
- Do **not** add a status-bar click handler (Zed has no extension API for it).
- Do **not** register a custom keymap in the extension. README may mention user-level `editor::ToggleCodeActions`.
- `autoEdit: false` remains a master off switch. `.git` paths never auto-edit.
- `keyFile` only fills `SOPS_AGE_SSH_PRIVATE_KEY_FILE`. Native age keys stay `env.SOPS_AGE_KEY_FILE`. Explicit `env` wins over `keyFile`.
- `execFile` only. Tests in `server/test/`, never bundled.
- Do not commit customer repos. Live tests use `/tmp` copies plus one `data-dotdex` open closed with no Save.
- WASM for Zed must be a **component** (`\0asm\r\x00\x01\x00`) linked with `wasm-component-ld`, not a core module.

## File structure

| File | Role |
|---|---|
| `server/src/sidecar-open.ts` | `sidecarOpenEdit` (overwrite) + `ensureSidecarContent` + `restoreSidecarAfterOpen` (always write + utimes) |
| `server/test/sidecar-open.test.ts` | Payload and restore tests |
| `server/src/index.ts` | `openDecryptedFile`: ensure → applyEdit → restore; drop `showDocument` |
| `server/src/types.ts` | `autoEditAll`, `keyFile`; `parseSopsSettings` injects key into `env` |
| `server/test/settings.test.ts` | Defaults and keyFile/env precedence |
| `server/src/sops-config.ts` | `isAutoEditAllowed` honors `autoEditAll` |
| `server/test/config.test.ts` | autoEditAll true without `.sops.yaml`; still respects autoEdit false and `.git` |
| `src/lib.rs` | Default `autoEditAll: false` if missing |
| `README.md` | Settings + focus workaround + keymap note |
| `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md` | Auto-edit + applyEdit + settings |
| `server/dist/index.js` | Rebuilt bundle |

---

### Task 1: Open edit = overwrite; restore sidecar after truncate (TDD)

**Files:**
- Modify: `server/src/sidecar-open.ts`
- Modify: `server/test/sidecar-open.test.ts`

**Interfaces:**
- Produces:
  - `export function sidecarOpenEdit(decryptedUri: string): { documentChanges: ReturnType<typeof CreateFile.create>[] }`
  - `export async function ensureSidecarContent(filePath: string, content: string): Promise<void>` (unchanged)
  - `export async function restoreSidecarAfterOpen(filePath: string, content: string): Promise<void>` — always `writeFile` + `chmod 0o600` + `utimes(now, now)`

- [ ] **Step 1: Rewrite the failing tests**

Replace `server/test/sidecar-open.test.ts` with:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd server && npx tsx --test test/sidecar-open.test.ts
```

Expected: FAIL — `sidecarOpenEdit` still has `overwrite: false` / missing `restoreSidecarAfterOpen`.

- [ ] **Step 3: Implement**

`server/src/sidecar-open.ts`:

```typescript
import * as fs from "fs/promises";
import { CreateFile } from "vscode-languageserver/node";

export function sidecarOpenEdit(decryptedUri: string): {
  documentChanges: ReturnType<typeof CreateFile.create>[];
} {
  return {
    documentChanges: [
      CreateFile.create(decryptedUri, {
        overwrite: true,
        ignoreIfExists: false,
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

export async function restoreSidecarAfterOpen(
  filePath: string,
  content: string
): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  const now = new Date();
  await fs.utimes(filePath, now, now);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd server && npx tsx --test test/sidecar-open.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sidecar-open.ts server/test/sidecar-open.test.ts
git commit -m "$(cat <<'EOF'
fix: open sidecar with overwrite then restore plaintext on disk

CreateFile overwrite focuses the tab in Zed. Rewrite + utimes after
truncate so the buffer reloads clean and non-empty. No TextEdit.
EOF
)"
```

---

### Task 2: Wire `openDecryptedFile` to restore after applyEdit

**Files:**
- Modify: `server/src/index.ts` (`openDecryptedFile`)

**Interfaces:**
- Consumes: `ensureSidecarContent`, `sidecarOpenEdit`, `restoreSidecarAfterOpen`
- Produces: `openDecryptedFile` still `Promise<boolean>`; fallback message unchanged

- [ ] **Step 1: Replace `openDecryptedFile`**

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
    await restoreSidecarAfterOpen(decryptedFilePath, content);
    return result.applied;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
    try {
      await restoreSidecarAfterOpen(decryptedFilePath, content);
    } catch {
      // sidecar may already be gone
    }
    return false;
  }
}
```

Remove the `showDocument` try/catch (Zed 1.19 logs it as unhandled and does not focus).

Update the import:

```typescript
import {
  ensureSidecarContent,
  restoreSidecarAfterOpen,
  sidecarOpenEdit,
} from "./sidecar-open";
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd server && npx tsc --noEmit
```

Expected: PASS. `rg showDocument server/src/index.ts` empty. `rg TextEdit server/src/index.ts` empty.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "$(cat <<'EOF'
fix: restore sidecar bytes after Zed CreateFile truncate

applyEdit opens the tab; restoreSidecarAfterOpen puts plaintext
back so Zed reloads a clean focused buffer.
EOF
)"
```

---

### Task 3: `autoEditAll` + `keyFile`

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/test/settings.test.ts`
- Modify: `server/src/sops-config.ts` (`isAutoEditAllowed`)
- Modify: `server/test/config.test.ts`
- Modify: `src/lib.rs` (default `autoEditAll` false)

**Interfaces:**
- Produces: `SopsSettings` fields `autoEditAll: boolean` (default `false`), `keyFile: string` (default `""`)
- `parseSopsSettings`: if `keyFile` is a non-empty string and `env.SOPS_AGE_SSH_PRIVATE_KEY_FILE` is not already set, add it
- `isAutoEditAllowed(absolutePath, settings: Pick<SopsSettings, "autoEdit" | "autoEditAll">, ...)`:
  1. `autoEdit === false` → `false`
  2. path contains `/.git/` or `\.git\` → `false`
  3. `autoEditAll === true` → `true` (no `.sops.yaml` required)
  4. else existing creation_rules walk

- [ ] **Step 1: Failing settings tests**

Add to `server/test/settings.test.ts`:

```typescript
  it("defaults autoEditAll false and keyFile empty", () => {
    assert.equal(DEFAULT_SOPS_SETTINGS.autoEditAll, false);
    assert.equal(DEFAULT_SOPS_SETTINGS.keyFile, "");
  });

  it("injects keyFile as SOPS_AGE_SSH_PRIVATE_KEY_FILE when env omits it", () => {
    const parsed = parseSopsSettings({
      keyFile: "/Users/me/id_rsa",
    });
    assert.equal(parsed.keyFile, "/Users/me/id_rsa");
    assert.equal(parsed.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/Users/me/id_rsa");
  });

  it("does not override env.SOPS_AGE_SSH_PRIVATE_KEY_FILE with keyFile", () => {
    const parsed = parseSopsSettings({
      keyFile: "/Users/me/id_rsa",
      env: { SOPS_AGE_SSH_PRIVATE_KEY_FILE: "/other/key" },
    });
    assert.equal(parsed.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/other/key");
    assert.equal(parsed.keyFile, "/Users/me/id_rsa");
  });
```

- [ ] **Step 2: Run to fail**

```bash
cd server && npx tsx --test test/settings.test.ts
```

Expected: FAIL on missing `autoEditAll` / `keyFile`.

- [ ] **Step 3: Implement parseSopsSettings**

In `server/src/types.ts`, extend `SopsSettings` and defaults:

```typescript
export interface SopsSettings {
  sopsPath: string;
  env: Record<string, string>;
  autoEdit: boolean;
  autoEditAll: boolean;
  keyFile: string;
  timeoutMs: number;
}

export const DEFAULT_SOPS_SETTINGS: SopsSettings = {
  sopsPath: "sops",
  env: {},
  autoEdit: true,
  autoEditAll: false,
  keyFile: "",
  timeoutMs: 60_000,
};
```

In `parseSopsSettings`, after building `env`:

```typescript
  const keyFile =
    typeof obj.keyFile === "string" ? obj.keyFile : defaults.keyFile;
  const mergedEnv = { ...env };
  if (
    keyFile.length > 0 &&
    typeof mergedEnv.SOPS_AGE_SSH_PRIVATE_KEY_FILE !== "string"
  ) {
    mergedEnv.SOPS_AGE_SSH_PRIVATE_KEY_FILE = keyFile;
  }
  return {
    sopsPath: /* existing */,
    env: mergedEnv,
    autoEdit: typeof obj.autoEdit === "boolean" ? obj.autoEdit : defaults.autoEdit,
    autoEditAll:
      typeof obj.autoEditAll === "boolean" ? obj.autoEditAll : defaults.autoEditAll,
    keyFile,
    timeoutMs: /* existing */,
  };
```

- [ ] **Step 4: Failing autoEditAll tests**

Add to `describe("isAutoEditAllowed")` in `server/test/config.test.ts`:

```typescript
  it("is true for autoEditAll without a .sops.yaml", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "outside", "secrets.yaml");
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(
        file,
        { autoEdit: true, autoEditAll: true },
        [root]
      ),
      true
    );
  });

  it("is false for autoEditAll when autoEdit is false", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "secrets.yaml");
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(
        file,
        { autoEdit: false, autoEditAll: true },
        [root]
      ),
      false
    );
  });

  it("is false for autoEditAll when the path contains /.git/", async () => {
    const root = await makeTempDir();
    const file = path.join(root, ".git", "secrets.yaml");
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(
        file,
        { autoEdit: true, autoEditAll: true },
        [root]
      ),
      false
    );
  });
```

Update existing `isAutoEditAllowed(...)` calls that pass `{ autoEdit: ... }` — TypeScript will require `autoEditAll` if the Pick includes it. Pass `autoEditAll: false` on old tests.

- [ ] **Step 5: Implement isAutoEditAllowed**

```typescript
export async function isAutoEditAllowed(
  absolutePath: string,
  settings: Pick<SopsSettings, "autoEdit" | "autoEditAll">,
  workspaceFolders: string[],
  warn?: (msg: string) => void
): Promise<boolean> {
  if (!settings.autoEdit) return false;
  if (containsGitSegment(absolutePath)) return false;
  if (settings.autoEditAll) return true;
  const configPath = findSopsConfigPath(absolutePath, workspaceFolders);
  // ... rest unchanged
}
```

- [ ] **Step 6: Default in WASM host**

In `src/lib.rs` `lsp_options`, after the `autoEdit` default:

```rust
    if !map.contains_key("autoEditAll") {
        map.insert("autoEditAll".to_string(), Value::Bool(false));
    }
```

Do not invent a default `keyFile`.

- [ ] **Step 7: Full unit suite**

```bash
cd server && npx tsc --noEmit && npm test
```

Expected: all tests PASS (previous 48 plus the new ones).

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts server/test/settings.test.ts server/src/sops-config.ts server/test/config.test.ts src/lib.rs
git commit -m "$(cat <<'EOF'
feat: add autoEditAll and keyFile for SOPS auto-decrypt

autoEditAll decrypts any detected SOPS file without .sops.yaml
matching. keyFile fills SOPS_AGE_SSH_PRIVATE_KEY_FILE unless env
already sets it. autoEdit remains the master off switch.
EOF
)"
```

---

### Task 4: Spec, README, bundle

**Files:**
- Modify: `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md`
- Modify: `README.md`
- Modify: `server/dist/index.js` (build)

- [ ] **Step 1: Spec**

Replace the `isAutoEditAllowed` bullet list with:

```
`isAutoEditAllowed` is true only when:

1. `settings.autoEdit` is true (default).
2. The absolute path does not contain `/.git/` or `\.git\`.
3. Either `settings.autoEditAll` is true, **or** the closest config exists and at least one `creation_rules` entry matches.

No config file → no auto-edit unless `autoEditAll` is true. Encrypted files still get the diagnostic and code action.
```

Replace Start session applyEdit step 4 with:

```
4. Ensure the sidecar on disk contains the plaintext (`0o600`). `applyEdit`: `CreateFile` with `overwrite: true` only — no `TextEdit` (TextEdit dirties the buffer and blocks reload). Then rewrite the sidecar plaintext and `utimes` so Zed reloads a focused, clean, non-empty tab. If `applied === false` or the call throws, still restore disk bytes and `window/showInformationMessage`: `SOPS: decrypted to <path> — open it to edit.`
```

In the settings JSON example add `"autoEditAll": false` and `"keyFile": "/Users/me/id_rsa"`. Keep `env.SOPS_AGE_KEY_FILE` as the native-age path.

- [ ] **Step 2: README**

Replace the settings example with:

```json
{
  "lsp": {
    "sops-lsp": {
      "settings": {
        "sopsPath": "/opt/homebrew/bin/sops",
        "keyFile": "/Users/me/.ssh/keys/private/vleonov-key",
        "autoEdit": true,
        "autoEditAll": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

Usage bullets:

- `autoEditAll: true` — auto-decrypt every SOPS YAML/JSON/TOML (not only `.sops.yaml` `path_regex`). Sidecar tab should focus; Save re-encrypts; Close deletes the sidecar.
- `keyFile` — SSH identity for age-ssh (`SOPS_AGE_SSH_PRIVATE_KEY_FILE`). For a native age key file use `env.SOPS_AGE_KEY_FILE`.
- `autoEdit: false` turns auto-decrypt off even if `autoEditAll` is true.
- Code action remains **SOPS: Edit decrypted** (`cmd-.`). Optional user keymap: `{ "cmd-shift-e": "editor::ToggleCodeActions" }`. The extension cannot bind a key to that action itself.
- Status-bar `SOPS encrypted` is a diagnostic, not a button.

- [ ] **Step 3: Rebuild bundle**

```bash
cd server && npm run build
```

Expected: `dist/index.js` contains `overwrite: true`, `restoreSidecarAfterOpen`, `autoEditAll`, no `showDocument` in the `openDecryptedFile` function.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md README.md server/dist/index.js
git commit -m "$(cat <<'EOF'
docs: document autoEditAll, keyFile, and sidecar focus workaround

Rebuild the LSP bundle so the WASM embed picks up overwrite-restore
open and the new settings.
EOF
)"
```

---

### Task 5: Component WASM + live Zed

**Files:**
- Rebuild: `target/wasm32-wasip1/release/zed_sops.wasm` (gitignored)
- Install: `~/Library/Application Support/Zed/extensions/installed/sops/extension.wasm`

- [ ] **Step 1: Build a Wasm component**

```bash
export PATH="/opt/homebrew/opt/lld@22/bin:/opt/homebrew/opt/wasm-component-ld/bin:$PATH"
cd /Users/vleonov/.t3/worktrees/zed-sops/t3code-dbab43e0
cargo build --release --target wasm32-wasip1 \
  --config /opt/homebrew/opt/rust-wasm/share/rust-wasm/cargo-config.toml \
  --config 'target.wasm32-wasip1.linker="wasm-component-ld"'
python3 -c "from pathlib import Path; b=Path('target/wasm32-wasip1/release/zed_sops.wasm').read_bytes()[:8]; assert b==b'\\x00asm\\r\\x00\\x01\\x00', b"
```

Do not install a core module (`\0asm\x01\x00\x00\x00`).

- [ ] **Step 2: Install without Command Palette**

Copy wasm + `extension.toml` into `~/Library/Application Support/Zed/extensions/installed/sops/`. Confirm Zed.log `reloading 1` without `Failed to load extension: sops`. Do not send palette keystrokes into the T3 Code window.

- [ ] **Step 3: Isolated live checks**

Use copies (not customer git). `.zed/settings.json`:

```json
{
  "lsp": {
    "sops-lsp": {
      "settings": {
        "sopsPath": "/opt/homebrew/bin/sops",
        "keyFile": "/Users/vleonov/.ssh/keys/private/vleonov-key",
        "autoEdit": true,
        "autoEditAll": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

Layout:

```
/tmp/zed-sops-auto-all/
  .zed/settings.json
  .sops.yaml          # path_regex hostgroups/.*\.d/.*\.yaml$ only
  hostgroups/prometheus.d/secrets.yaml
  outside/secrets.yaml
```

Copy ciphertext from `data-dotdex/hostgroups/prometheus.d/secrets.yaml`. Close any previous test window, then `zed -n /tmp/zed-sops-auto-all` and open `outside/secrets.yaml` (does **not** match path_regex).

Pass if:

1. Window title contains `secrets.decrypted.yaml` (tab focused).
2. Sidecar on disk size **> 0**, mode `0o600`, no `ENC[`.
3. File → Close Editor: **no** Save dialog; sidecar deleted.
4. Open `hostgroups/prometheus.d/secrets.yaml`: same focus + non-empty sidecar (regression of rule-based auto-edit).
5. Set `autoEditAll: false` in `.zed/settings.json`, reload LSP by closing the window and reopening `outside/secrets.yaml`: **no** sidecar (still no matching rule).

- [ ] **Step 4: Customer file, no save**

Open `/Users/vleonov/Documents/projects/customers/data-dotdex/hostgroups/prometheus.d/secrets.yaml`. Confirm focused sidecar, size > 0. Close Editor (Don't Save only if a dialog appears). `git status` clean in `data-dotdex`; July ciphertext mtime/size unchanged.

- [ ] **Step 5: No extra commit unless live test forced a code fix**

If restore race still leaves a 0-byte buffer, add `await new Promise((r) => setTimeout(r, 50))` between applyEdit and restore **only after** seeing that failure, rebuild, re-test, then:

```bash
git add server/src/index.ts server/dist/index.js
git commit -m "$(cat <<'EOF'
fix: delay sidecar restore until after Zed finishes CreateFile truncate

A 0-byte reload raced the plaintext rewrite on Zed 1.19.
EOF
)"
```

Do not add the delay speculatively.

---

## Verification (done when all of these are true)

- `cd server && npx tsc --noEmit && npm test` — 0 failures.
- `openDecryptedFile` has no `TextEdit` and no `showDocument`.
- Live Zed: `autoEditAll` focuses a non-empty clean sidecar for a file outside `path_regex`; Close has no Save prompt; `data-dotdex` git clean.
- No commits under `/Users/vleonov/Documents/projects/customers`.
