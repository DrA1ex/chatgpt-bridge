#!/usr/bin/env bash
set -euo pipefail
: "${API_TOKEN:?Set API_TOKEN first}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
curl -sS -H "Authorization: Bearer $API_TOKEN" "$BASE_URL/sessions" | jq
