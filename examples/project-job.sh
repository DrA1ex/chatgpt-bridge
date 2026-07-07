#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
TOKEN_HEADER=()
if [[ -n "${API_TOKEN:-}" ]]; then
  TOKEN_HEADER=(-H "Authorization: Bearer ${API_TOKEN}")
fi

PROJECT_ZIP="${1:?usage: examples/project-job.sh ./project.zip 'task text'}"
TASK="${2:?usage: examples/project-job.sh ./project.zip 'task text'}"

UPLOAD_JSON=$(node -e 'const fs=require("fs"); const path=process.argv[1]; console.log(JSON.stringify({name:require("path").basename(path), mime:"application/zip", contentBase64:fs.readFileSync(path).toString("base64")}));' "$PROJECT_ZIP")
FILE_ID=$(curl -sS -X POST "$BASE_URL/files" "${TOKEN_HEADER[@]}" -H 'Content-Type: application/json' -d "$UPLOAD_JSON" | node -pe 'JSON.parse(fs.readFileSync(0,"utf8")).file.id')

JOB=$(curl -sS -X POST "$BASE_URL/project-jobs" "${TOKEN_HEADER[@]}" -H 'Content-Type: application/json' -H "Idempotency-Key: project-job-$(date +%s)" -d "$(node -e 'console.log(JSON.stringify({projectName:"project", inputFileId:process.argv[1], message:process.argv[2], sessionPolicy:"new_per_job", result:{format:"zip", required:true}}))' "$FILE_ID" "$TASK")")
echo "$JOB"
