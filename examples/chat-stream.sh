#!/usr/bin/env bash
set -euo pipefail

: "${API_TOKEN:?Set API_TOKEN to the value from .env}"

curl -N -X POST 'http://127.0.0.1:8080/chat?stream=1' \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}'
