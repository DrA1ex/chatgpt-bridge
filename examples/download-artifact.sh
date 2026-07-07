#!/usr/bin/env bash
set -euo pipefail
: "${API_TOKEN:?Set API_TOKEN first}"
: "${ARTIFACT_ID:?Set ARTIFACT_ID first}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
OUT="${OUT:-artifact.bin}"
curl -L -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/artifacts/$ARTIFACT_ID/download" -o "$OUT"
echo "Saved to $OUT"
