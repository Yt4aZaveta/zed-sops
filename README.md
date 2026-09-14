# SOPS for Zed

Edit [SOPS](https://github.com/getsops/sops)-encrypted YAML, JSON, and TOML in Zed via a plaintext sidecar. Zed has no virtual documents, so the decrypted buffer is a real file next to the original.

## Install

1. Install the `sops` binary and make sure it is on `PATH` (or set `sopsPath` below).
2. Install this extension in Zed.
3. Optional user settings:

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

- `autoEditAll: true` — auto-decrypt every SOPS YAML/JSON/TOML (not only `.sops.yaml` `path_regex`). Sidecar tab should focus; Save re-encrypts; Close deletes the sidecar.
- `keyFile` — SSH identity for age-ssh (`SOPS_AGE_SSH_PRIVATE_KEY_FILE`). For a native age key file use `env.SOPS_AGE_KEY_FILE`.
- `autoEdit: false` turns auto-decrypt off even if `autoEditAll` is true.
- Code action remains **SOPS: Edit decrypted** (`cmd-.`). Optional user keymap: `{ "cmd-shift-e": "editor::ToggleCodeActions" }`. The extension cannot bind a key to that action itself.
- Status-bar `SOPS encrypted` is a diagnostic, not a button.

## Usage

1. Open a SOPS-encrypted YAML/JSON/TOML file. A diagnostic appears: `SOPS encrypted`.
2. Run the code action **SOPS: Edit decrypted**, or let auto-edit start a session (`autoEditAll`, or a matching `.sops.yaml` `creation_rules` entry).
3. Edit the sidecar tab (`elk.yaml` → `.decrypted.elk.yaml`). Save it to re-encrypt the original. Close it to delete the plaintext sidecar. Opening any other file (except this ciphertext/sidecar pair) deletes the sidecar unless it has unsaved edits. Switching between already-open tabs may not notify the LSP; opening a file does.
4. The ciphertext tab stays open; that is a Zed limitation, not a leak of the edit session.

## Gitignore

Add these patterns so plaintext sidecars are never committed:

```
.decrypted.*
*.decrypted.yaml
*.decrypted.yml
*.decrypted.json
*.decrypted.toml
*.decrypted.ini
```

## YAML language server order

If go-to-definition on YAML breaks, keep `yaml-language-server` ahead of `sops-lsp`:

```json
{
  "languages": {
    "YAML": {
      "language_servers": ["yaml-language-server", "sops-lsp"]
    }
  }
}
```
