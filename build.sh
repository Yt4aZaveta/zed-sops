#!/bin/bash
set -e

echo "Installing server dependencies..."
cd server && npm install

echo "Building bundled language server..."
npm run build
cd ..

echo "Build complete."
