#!/bin/sh
# Bootstrap build for Vercel.
# The Vercel project is not git-linked yet (the connected GitHub identity lacks write
# access to the repo), so this script clones the public repo and assembles the real app
# (src/, api/, public/, package.json, vercel.json) into the build directory.
set -e

REPO="https://github.com/hillarytizian-boop/Wa-bulk-ai.git"

echo "[bootstrap] cloning $REPO"
git clone --depth 1 "$REPO" /tmp/repo

echo "[bootstrap] copying application files"
cp -r /tmp/repo/src ./src
cp -r /tmp/repo/api ./api
cp -r /tmp/repo/public ./public
cp /tmp/repo/package.json ./package.json

# The serverless bundle traces files next to the function, so keep a copy of the static
# site inside api/ (src/server.js looks for public/ in both locations).
cp -r /tmp/repo/public ./api/public

# vercel.json cannot be uploaded through the deployment API, so it is generated here.
# includeFiles ships public/ inside the serverless bundle (the Express app serves the SPA),
# and crons drive order polling + M-Pesa reconciliation on a schedule.
cat > vercel.json <<'JSON'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "version": 2,
  "functions": {
    "api/index.js": {
      "maxDuration": 60,
      "memory": 1024,
      "includeFiles": "public/**"
    }
  },
  "crons": [{ "path": "/api/cron/tick", "schedule": "15 2 * * *" }]
}
JSON

echo "[bootstrap] installing production dependencies"
npm install --omit=dev --omit=optional --no-audit --no-fund

echo "[bootstrap] done: src=$(ls src/*.js | wc -l) files, api=$(ls api/*.js | wc -l) files, public=$(ls public | wc -l) files"
