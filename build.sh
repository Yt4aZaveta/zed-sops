#!/bin/bash
set -euo pipefail

cd server
npm ci
npm test
npm run build
cd ..

cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo check --target wasm32-wasip2
