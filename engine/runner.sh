#!/bin/bash
# Runs inside a Vercel Sandbox. Env: JOB_ID, INPUT_URL, INPUT_EXT, NEEDS_SETUP, BLOB_READ_WRITE_TOKEN
set -u
cd /tmp/job
mkdir -p out
echo '{"stage":"start","pct":0,"message":"przygotowanie"}' > out/progress.json

if [ "${NEEDS_SETUP:-0}" = "1" ]; then
  echo '{"stage":"setup","pct":0,"message":"instalacja narzędzi (pierwsze uruchomienie)"}' > out/progress.json
  bash /tmp/job/setup.sh > out/setup.log 2>&1
fi

echo '{"stage":"download","pct":0,"message":"pobieranie pliku"}' > out/progress.json
if ! curl -sSL --fail --retry 3 -o "input.${INPUT_EXT}" "$INPUT_URL"; then
  echo '{"ok":false,"error":"Nie udało się pobrać pliku wejściowego"}' > out/manifest.json
else
  python3 studio.py --input "input.${INPUT_EXT}" --outdir out --params params.json > out/log.txt 2>&1
fi

echo '{"stage":"upload","pct":99,"message":"zapisywanie wyników"}' > out/progress.json
cp /tmp/job/upload.mjs /opt/uploader/upload.mjs
cd /opt/uploader && node upload.mjs
echo '{"stage":"finished","pct":100,"message":"gotowe"}' > /tmp/job/out/progress.json
