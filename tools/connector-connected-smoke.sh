#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <connector-image>" >&2
  exit 64
fi

image="$1"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/sqlsimcity-connected-smoke.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

common=(
  --read-only
  --tmpfs /spool:rw,noexec,nosuid,size=16m
  --cap-drop ALL
  --security-opt no-new-privileges
  --env SQLSIMCITY_EDGE_CONNECTOR_ID=edge-smoke
  --env SQLSIMCITY_EDGE_TARGET_ID=target-smoke
  --env SQLSIMCITY_EDGE_KEY_ID=key-smoke
  --env SQLSIMCITY_EDGE_INGEST_ENDPOINT=https://central.example/api/v1/edge/ingest
  --env SQLSIMCITY_EDGE_SIGNING_SECRET_FILE=/run/test/signing.b64
  --env SQLSIMCITY_EDGE_SPOOL_DIR=/spool
  --env SQLSIMCITY_EDGE_SPOOL_KEY_FILE=/run/test/spool-key.json
  --env SQLSIMCITY_EDGE_SOURCE_MODE=Connected
)

run_failure() {
  local log_file="$1"
  shift
  set +e
  docker run --rm "${common[@]}" "$@" "${image}" >"${log_file}" 2>&1
  local status="$?"
  set -e
  if [[ "${status}" -ne 78 ]]; then
    cat "${log_file}" >&2
    echo "connected fail-closed smoke exited ${status}, expected 78" >&2
    exit 1
  fi
  if grep --extended-regexp --ignore-case --quiet \
    '(password|secret|token|certificate)[[:space:]]*[:=][[:space:]]*[^[:space:]]+' \
    "${log_file}"; then
    echo "connected fail-closed log may contain secret material" >&2
    exit 1
  fi
}

run_failure "${work_dir}/missing-config.log"
grep --fixed-strings --quiet "SQLSIMCITY_EDGE_SQL_PLATFORM" \
  "${work_dir}/missing-config.log"

mkdir "${work_dir}/sql-secrets"
printf '%s\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' \
  >"${work_dir}/signing.b64"
printf '%s\n' \
  '{"formatVersion":1,"keyVersion":1,"key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}' \
  >"${work_dir}/spool-key.json"

run_failure "${work_dir}/missing-auth-secret.log" \
  --volume "${work_dir}:/run/test:ro" \
  --env SQLSIMCITY_EDGE_SQL_HOST=sql.example.internal \
  --env SQLSIMCITY_EDGE_SQL_PORT=1433 \
  --env SQLSIMCITY_EDGE_SQL_INITIAL_DATABASE=appdb \
  --env SQLSIMCITY_EDGE_SQL_PLATFORM=SqlServerOnPremises \
  --env SQLSIMCITY_EDGE_SQL_TARGET_DISPLAY_NAME=Smoke \
  --env SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES=appdb \
  --env SQLSIMCITY_EDGE_SQL_SECRETS_DIR=/run/test/sql-secrets \
  --env SQLSIMCITY_EDGE_SQL_AUTH_MODE=SqlLogin \
  --env SQLSIMCITY_EDGE_SQL_USERNAME=collector \
  --env SQLSIMCITY_EDGE_SQL_PASSWORD_SECRET_FILE=missing-password
grep --fixed-strings --quiet \
  "A configured SQL authentication secret file is missing, invalid, empty, or unreadable." \
  "${work_dir}/missing-auth-secret.log"
if grep --extended-regexp --quiet \
  '(sql\.example\.internal|missing-password|/run/test)' \
  "${work_dir}/missing-auth-secret.log"; then
  echo "connected fail-closed log exposed configured identifiers" >&2
  exit 1
fi

echo "connected connector fail-closed smokes passed"
