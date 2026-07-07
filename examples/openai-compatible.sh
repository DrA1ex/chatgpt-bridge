#!/usr/bin/env bash
set -euo pipefail

: "${API_TOKEN:?Set API_TOKEN to the value from .env}"

curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"chatgpt",
    "messages":[
      {"role":"user","content":"Hello"}
    ]
  }' | jq
