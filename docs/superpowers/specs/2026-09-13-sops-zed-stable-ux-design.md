# SOPS for Zed: stable edit UX

Date: 2026-09-13  
Status: approved in design conversation; awaiting spec review before planning  
Repo: zed-sops (Zed extension + Node LSP)

## Problem

The extension decrypts SOPS files by writing a plaintext sidecar and re-encrypting on save. That is the right shape for Zed (no virtual documents, no reliable in-buffer decrypt because of autosave). The current implementation is not.

Today it auto-decrypts on every open of a YAML/JSON/TOML/Plain Text buffer that looks like SOPS, writes `.decrypted~secrets.yaml` into the project, tries to open it with a `CreateFile` + `applyEdit` hack, and attaches a language server that can steal `yaml-language-server` as primary. Save restores a cached ciphertext then runs `sops` with an EDITOR script; races, stale disk, and failed encrypt can leave secrets or a broken file behind. Settings (`sopsPath`, `env`) are read by the LSP but never supplied by the WASM host. There are no tests.

## Goals

Make encrypted-file editing stable and as native as Zed allows:

1. Do not decrypt just because a SOPS file was opened.
2. Offer an explicit **Edit decrypted** code action; auto-open only when `.sops.yaml` says this path is in scope.
3. Sidecar lives next to the original as `.decrypted.secrets.yaml` (not `secrets.decrypted.yaml` or `.decrypted~secrets.yaml`).
4. One edit session per file, with a save queue, stale-disk check, and ciphertext backup/rollback.
5. Do not implement hover/definition/completion, so we do not become the primary YAML LSP.
6. Wire real settings from Zed. Cover detector, `.sops.yaml` matching, and session lifecycle with tests.

## Non-goals

- Encrypting brand-new files via `creation_rules`.
- Binary SOPS files as a first-class edit type (TOML is the only binary-typed format we pass through; see File types).
- In-buffer decrypt of the ciphertext tab.
- Closing the ciphertext tab (Zed has no API).
- Virtual `sops://` documents, status-bar items, context menus.
- Attaching to Plain Text (too broad). `.env` / dotenv SOPS files are out of this version.
- Progress notifications (`workDoneProgress`).
- Publishing to the Zed extension registry.

## Zed constraints (do not fight these)

- Extensions are WASM + optional LSP. No custom editor, no virtual document, no reliable `window/showDocument` for local files.
- `workspace/applyEdit` with `CreateFile` is the available way to open a sidecar tab; it can fail. If it fails, the sidecar must still exist on disk and the user is told to open it.
- The ciphertext tab stays open. UX is diagnostics on that tab, not tab management.
- User settings arrive only if the extension implements `language_server_initialization_options` / workspace configuration via `LspSettings::for_worktree`.
- `worktree.shell_env()` is how age/KMS/PATH from the user's shell reach `sops`.
- `worktree.which("sops")` is how we resolve the binary when `sopsPath` is unset.

## Architecture

Two processes, same split as today:

```
Zed
 └─ SopsExtension (Rust WASM)
      language_server_command → node <bundled index.js> --stdio
      language_server_initialization_options → { sopsPath, env, autoEdit, timeoutMs }
 └─ sops-lsp (Node, single bundled file)
      detector, config, runner, edit session, LSP wiring
```

The WASM host stays thin. It does not decrypt. It writes **one** bundled `index.js` into the extension work dir (esbuild), starts Node, and passes settings. Runtime `npm_install_package` for `vscode-languageserver` goes away; the bundle includes those deps.

The LSP advertises only:

- `textDocumentSync` (full, open/close, save with `includeText`)
- `codeActionProvider`
- `executeCommandProvider` for `sops.editDecrypted`

No hover, definition, completion, or formatting.

`extension.toml` languages: `YAML`, `JSON`, `TOML`. Remove `Plain Text`.

### Modules

| File | Responsibility |
|---|---|
| `src/lib.rs` | Embed bundle, start node, pass `LspSettings` + `which("sops")` + `shell_env()` |
| `server/src/index.ts` | LSP handlers only |
| `server/src/sops-detector.ts` | Ciphertext vs sidecar, path roundtrip, file type |
| `server/src/sops-config.ts` | Walk-up `.sops.yaml`, `creation_rules` / `path_regex` match |
| `server/src/sops-runner.ts` | `sops decrypt` / `sops <file>` EDITOR trick, timeout |
| `server/src/edit-session.ts` | Session map, queue, backup, sidecar create/delete |
| `server/src/types.ts` | Shared types |
| `server/test/*.test.ts` | Node tests; never compiled into the bundle |

`server/src/file-state.ts` is deleted; `FileStateManager` is replaced by `EditSessionRegistry`.

## Sidecar naming

For a path with a non-empty extension (Node `path.parse(p).ext !== ""` and the basename is not a dotfile-only name like `.env`):

- encrypted `dir/secrets.yaml` → sidecar `dir/.decrypted.secrets.yaml`
- same for `.yml`, `.json`, `.toml`, `.ini`

Insert the literal segment `.decrypted` immediately before the final extension. Inverse: if the basename matches `^(.*)\.decrypted(\.[^.]+)$`, the encrypted basename is `$1$2`.

Also treat the **legacy** prefix `.decrypted~*` as a sidecar for adopt/cleanup only. Never create new files with that prefix.

Collision: if the sidecar path exists and the companion encrypted file is SOPS ciphertext, treat as an orphan of ours and overwrite on session start. If the sidecar path exists and the companion is **not** SOPS ciphertext, refuse and show an error; do not overwrite a user file.

## File types

`detectFileType` from path:

| Path | `SopsFileType` passed to sops |
|---|---|
| `.yaml` / `.yml` | `yaml` |
| `.json` | `json` |
| `.ini` | `ini` |
| `.toml` | `binary` (sops has no toml store; binary preserves bytes) |
| other | `yaml` |

Detection of ciphertext (`isSopsEncrypted`):

- json: parsed object has `sops.version` string
- yaml: a line matching `^sops:\s*$` followed later by `version:` at deeper indent (keep current heuristic)
- ini: contains `[sops]`
- toml / binary: contains `[sops]` or `sops.version` / `ENC[AES256_GCM`

If JSON parse fails, return false (do not guess).

## `.sops.yaml` matching

Walk from the encrypted file's directory up to the containing workspace folder (from `InitializeParams.workspaceFolders`). Stop at the first `.sops.yaml` or `.sops.yml`. Do not walk above the workspace. If no workspace folder contains the file (single-file window), look only in the file's own directory — no walk-up.

Parse with a real YAML parser (`yaml` package, bundled). Look at `creation_rules` (array). Missing or non-array `creation_rules` → no rule matches. A rule matches when:

- `path_regex` is missing or empty → catch-all, matches, or
- `path_regex` as a JavaScript `RegExp` matches the file path relative to the config file's directory, using forward slashes.

If the regex is invalid, the rule does not match (log a warning; do not crash).

`isAutoEditAllowed` is true only when:

1. `settings.autoEdit` is true (default).
2. The absolute path does not contain `/.git/` or `\.git\`.
3. Either `settings.autoEditAll` is true, **or** the closest config exists and at least one `creation_rules` entry matches.

No config file → no auto-edit unless `autoEditAll` is true. Encrypted files still get the diagnostic and code action.

## Settings

Zed user config (example):

```json
{
  "lsp": {
    "sops-lsp": {
      "settings": {
        "sopsPath": "/opt/homebrew/bin/sops",
        "env": { "SOPS_AGE_KEY_FILE": "/Users/me/key.txt" },
        "keyFile": "/Users/me/id_rsa",
        "autoEdit": true,
        "autoEditAll": false,
        "timeoutMs": 60000
      }
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `sopsPath` | `worktree.which("sops")` then `"sops"` | Binary |
| `env` | `{}` | Extra env for sops; merged over `process.env` (shell env already on the process via `Command.env`) |
| `autoEdit` | `true` | Auto session start when `.sops.yaml` matches |
| `timeoutMs` | `60000` | Kill `sops` after this many ms |

WASM `language_server_initialization_options` reads `LspSettings::for_worktree("sops-lsp", worktree)`, merges `settings` over `initialization_options`, fills `sopsPath` from `worktree.which("sops")` when unset, and returns JSON. The LSP uses that object in `onInitialize`. If Zed later sends `workspace/didChangeConfiguration`, refresh `autoEdit` / `timeoutMs` / `env`; `sopsPath` change is best-effort (no process restart required if we just store it).

Recommended (document in README, do not enforce): YAML `language_servers` lists `yaml-language-server` before `sops-lsp`.

## Diagnostics and commands

Source: `sops`. Range: first line of the document (`0:0`–end of line 0), severity **Information**.

| Code | Buffer | Message |
|---|---|---|
| `sops.encrypted` | ciphertext, no session | `SOPS encrypted` |
| `sops.editing` | ciphertext, session live | `SOPS: editing <sidecar basename>` |
| `sops.managed` | sidecar | `SOPS managed · save re-encrypts` |
| `sops.unavailable` | ciphertext | `SOPS binary not found` (only if verify() failed) |

Code action on `sops.encrypted` and `sops.unavailable` (unavailable still offers the action; it will fail with a clear error):

- title: `SOPS: Edit decrypted`
- kind: `quickfix`
- command: `sops.editDecrypted`
- argument: document URI

On sidecar: no edit action (already decrypted).

## Flow

### Open ciphertext

1. Ignore non-SOPS content. Clear our diagnostics for that URI.
2. If sops binary failed `verify()` at startup, publish `sops.unavailable`.
3. Else publish `sops.encrypted`.
4. If an on-disk sidecar exists and is **not** open in `TextDocuments`, delete it (orphan cleanup).
5. If auto-edit is allowed, start a session (same path as the command). Do not block `didOpen`.

### Open sidecar (`*.decrypted.*` or legacy `.decrypted~*`)

If a session already tracks this URI, no-op. Else if the companion encrypted file exists and is SOPS ciphertext, **adopt**: create a session in `decrypted` with the current ciphertext bytes. Else ignore (not ours).

### Start session (`sops.editDecrypted` or auto)

Idempotent: if a session for that ciphertext already exists, do not decrypt again; try to open the sidecar if needed.

Otherwise:

1. `runner.decrypt(encryptedPath, fileType)`.
2. Write sidecar with mode `0o600`.
3. Register session: state `decrypted`, store ciphertext snapshot, paths, file type.
4. Ensure the sidecar on disk contains the plaintext (`0o600`). `applyEdit`: `CreateFile` with `overwrite: true` only — no `TextEdit` (TextEdit dirties the buffer and blocks reload). Then rewrite the sidecar plaintext and `utimes` so Zed reloads a focused, clean, non-empty tab. If `applied === false` or the call throws, still restore disk bytes and `window/showInformationMessage`: `SOPS: decrypted to <path> — open it to edit.`
5. Publish `sops.editing` on ciphertext and `sops.managed` on sidecar.

URI conversion: `fileURLToPath` / `pathToFileURL` from Node `url`. Do not `uri.slice(7)`.

### Save sidecar

`includeText` is on; prefer `document.getText()` as plaintext (fallback: read sidecar from disk).

Per session, one in-flight encrypt:

- If state is `encrypting`, store plaintext as `pending` (overwrite previous pending) and return.
- Set state `encrypting`.
- Stale check: read ciphertext file; if it differs from `session.encryptedContent`, fail with `SOPS: <file> changed on disk; not re-encrypting.` Leave sidecar in place, state `decrypted`.
- Backup ciphertext to a temp file (`0o600`) under `os.tmpdir()`.
- `runner.reEncrypt(encryptedPath, plaintext, fileType)`.
- On success: read new ciphertext, update snapshot, state `decrypted`. If `pending` is set, loop immediately with that plaintext.
- On failure: copy backup over the ciphertext path, state `decrypted`, keep sidecar, show error. Then if `pending` was set, do **not** auto-retry; drop pending and let the user save again.
- Always delete the backup temp file.

`reEncrypt` does **not** write the cached ciphertext onto the original first. The original stays ciphertext; `sops <file>` is the edit command. The EDITOR script must not interpolate paths into shell:

```sh
#!/bin/sh
cp "$SOPS_ZED_CONTENT" "$1"
```

`SOPS_ZED_CONTENT` is the temp plaintext file path, passed in env. Script mode `0o755`, plaintext temp `0o600`, both unlinked in `finally`.

### Close sidecar

Delete sidecar (`unlink`, ignore ENOENT). Remove session. If the ciphertext document is still open, publish `sops.encrypted` again (or `sops.unavailable`).

### Close ciphertext

Do not destroy a live session. Only clear diagnostics for that URI. Sidecar remains the editor.

### LSP shutdown / crash

Orphans are removed on the next ciphertext `didOpen` (step 4 of Open ciphertext). We do not walk the whole workspace at startup.

## Errors

| Situation | User-visible | Disk |
|---|---|---|
| sops missing at init | `window/showWarningMessage`: `SOPS binary not found. Install sops and ensure it is on PATH, or set lsp.sops-lsp.settings.sopsPath.` | nothing |
| decrypt fail | `showErrorMessage` with trimmed stderr (max ~800 chars) | no sidecar |
| encrypt fail | `showErrorMessage` trimmed stderr | ciphertext restored from backup; sidecar kept |
| stale ciphertext | `showErrorMessage` as above | no write |
| sidecar collision (not ours) | `showErrorMessage`: `SOPS: <path> already exists and is not a SOPS sidecar.` | no overwrite |
| applyEdit did not open | `showInformationMessage` with path | sidecar kept |
| sops timeout | treat as encrypt/decrypt fail | backup restore if we had one |
| `unhandledRejection` | log to `connection.console.error` | process stays up |
| `uncaughtException` | log; `process.exit(1)` | Zed restarts LSP |

Do not dump entire env or key material into messages. Prefer `error.stderr` from `execFile` when present.

## Runner

`execFile` (never `exec`). `maxBuffer` 10 MiB. `timeout` from settings. Env: `{ ...process.env, ...config.env }` plus EDITOR vars for re-encrypt.

`verify()`: `sops --version`. Called once after initialize; result cached (`ok` | `missing`).

## Tests

Runner: `tsx --test` (devDependency). Files in `server/test/`. Not part of the esbuild entry.

Minimum cases:

**detector**

- json/yaml/ini true and false
- toml with `[sops]` is encrypted; random toml is not
- `secrets.yaml` ↔ `.decrypted.secrets.yaml` roundtrip
- `foo.bar.yml` ↔ `foo.bar.decrypted.yml`
- legacy `.decrypted~secrets.yaml` is a sidecar; `getEncryptedPath` returns `secrets.yaml`

**config**

- no `.sops.yaml` → no match
- walk-up finds nested config before parent
- `path_regex: secrets/.*` matches `secrets/a.yaml` relative to config dir, not `other/a.yaml`
- rule without `path_regex` matches any path under that config
- invalid regex does not throw
- `isAutoEditAllowed` is false when the absolute path contains `/.git/` even if a catch-all rule matches

**session** (runner mocked)

- start writes sidecar `0o600` and records snapshot
- second start is idempotent (decrypt not called again)
- save coalesces two overlapping saves to the latest plaintext (one or two encrypts, last wins)
- stale snapshot aborts without calling reEncrypt
- reEncrypt throw restores backup bytes on the ciphertext path; sidecar still exists
- close deletes sidecar and drops session
- ciphertext open with on-disk sidecar and sidecar not in the open-doc set deletes the orphan
- collision with a non-SOPS companion does not overwrite

No Zed/WASM integration tests in this version.

## Build and ship

`build.sh`:

1. `npm install` in `server/`
2. `npm run build` → tsc then esbuild `src/index.ts` → `dist/index.js` (CJS, single file, all deps inlined)
3. WASM continues to `include_str!("../server/dist/index.js")` only

Commit `server/dist/index.js` as today so `cargo`/Zed can pack the extension without Node at pack time. Stop committing the per-module `dist/*.js` once the bundle is the only runtime file; delete unused dist artifacts in that change.

`lib.rs` writes only `dist/index.js` and does not call `npm_install_package`.

## README (short, required for sidecar-in-project)

- Install sops; optional `lsp.sops-lsp.settings`.
- Open a SOPS YAML/JSON/TOML file → diagnostic → `SOPS: Edit decrypted` (or auto if `.sops.yaml` matches).
- Save the `*.decrypted.*` tab to re-encrypt. Close it to delete plaintext.
- Add to project gitignore: `*.decrypted.yaml`, `*.decrypted.yml`, `*.decrypted.json`, `*.decrypted.toml`, `*.decrypted.ini`.
- Keep `yaml-language-server` ahead of `sops-lsp` in `languages.YAML.language_servers` if go-to-definition breaks.

## Compatibility

| Old | New |
|---|---|
| Auto-decrypt every SOPS open | Diagnostic + action; auto only on `.sops.yaml` match |
| `.decrypted~secrets.yaml` / `secrets.decrypted.yaml` | `.decrypted.secrets.yaml`; old names still cleaned up |
| In-place restore of ciphertext before every edit | Backup file + `sops` edit; original stays ciphertext |
| `Plain Text` attachment | Removed |
| Settings ignored | `LspSettings` wired |
| Multi-file `dist/*.js` + runtime npm | One bundle |

## Implementation order (for the later plan, not this spec's jobs)

1. Detector + naming tests, then implementation (including legacy prefix).
2. `.sops.yaml` loader tests, then implementation.
3. Edit session tests with mocked runner, then implementation.
4. Runner timeout + safe EDITOR env.
5. LSP rewire: diagnostics, code action, command, didOpen/Save/Close.
6. WASM settings + single-file bundle; drop runtime npm install.
7. Short README and `extension.toml` language list.

Each step stays inside this spec. Do not add creation_rules encryption or dotenv as a drive-by.
# Superseded

This design is superseded by `docs/superpowers/specs/2026-09-14-zed-sops-architecture-review.md` and `docs/superpowers/plans/2026-09-14-sops-zed-stable-no-data-loss.md`. Historical evidence below is retained unchanged.
