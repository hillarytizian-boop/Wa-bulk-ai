#!/bin/sh
# Bootstrap build for Vercel: the project is not git-linked yet, so this clones the public repo
# and assembles the real app (src/, api/, public/, package.json) into the build directory.
set -e

REPO="https://github.com/hillarytizian-boop/Wa-bulk-ai.git"

echo "[bootstrap] cloning $REPO"
git clone --depth 1 "$REPO" /tmp/repo

echo "[bootstrap] copying application files"
cp -r /tmp/repo/src ./src
cp -r /tmp/repo/api ./api
cp -r /tmp/repo/public ./public
cp /tmp/repo/package.json ./package.json

echo "[bootstrap] installing production dependencies"
npm install --omit=dev --omit=optional --no-audit --no-fund

echo "[bootstrap] done: src=$(ls src/*.js | wc -l) files, api=$(ls api/*.js | wc -l) file"
