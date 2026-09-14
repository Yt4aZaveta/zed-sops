# SOPS Zed live verification

## Automated evidence

- Baseline: `1fdd18c` descendant, branch `t3code/sops-zed-stable-no-data-loss-1`.
- `server/npm test`: 62 passing.
- `server/npm run build`: passing.
- `cargo fmt --check`, `cargo test`, and `cargo clippy --all-targets -- -D warnings`: passing.
- `cargo check --target wasm32-wasip2`: passed via the rustup-managed cargo after installing/verifying the target.
- The forbidden `workspace/applyEdit`, `CreateFile`, `DeleteFile`, and focus-eviction symbols are absent from `server/src` and `server/test`.

## Live matrix

The host has SOPS 3.13.3 and Zed 1.19.2 (`/Applications/Zed.app`). The complete interactive matrix was not run because preview/capability-specific Zed builds and a disposable interactive session were not available to the agent. No customer ciphertext, key material, or plaintext was used. The live release gate remains open until the matrix in the implementation plan is run on Zed 1.19.2, preview 1.20.0, and a build advertising `window/showDocument`.
