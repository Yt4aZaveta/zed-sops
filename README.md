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
        "env": { "SOPS_AGE_KEY_FILE": "/Users/me/key.txt" },
        "autoEdit": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

## Usage

1. Open a SOPS-encrypted YAML/JSON/TOML file. A diagnostic appears: `SOPS encrypted`.
2. Run the code action **SOPS: Edit decrypted**, or let auto-edit start a session when a `.sops.yaml` `creation_rules` entry matches this path (`autoEdit` defaults to true; no config file means no auto-edit).
3. Edit the sidecar tab (`secrets.yaml` → `secrets.decrypted.yaml`). Save it to re-encrypt the original. Close it to delete the plaintext sidecar.
4. The ciphertext tab stays open; that is a Zed limitation, not a leak of the edit session.

## Gitignore

Add these patterns so plaintext sidecars are never committed:

```
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
