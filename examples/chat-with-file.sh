#!/usr/bin/env bash
set -euo pipefail

: "${API_TOKEN:?Set API_TOKEN first}"
: "${FILE_PATH:?Set FILE_PATH first}"

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
NAME="${NAME:-$(basename "$FILE_PATH")}" 
MIME="${MIME:-application/octet-stream}"

FILE_ID=$(curl -sS -X POST "$BASE_URL/files/from-path" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"$FILE_PATH\",\"name\":\"$NAME\",\"mime\":\"$MIME\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).file.id))')

curl -sS -X POST "$BASE_URL/chat" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Summarize this attachment and list key risks.\",\"attachments\":[\"$FILE_ID\"]}" | jq
