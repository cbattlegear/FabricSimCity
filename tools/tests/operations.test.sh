#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/sqlsimcity-operations.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

make_wrapper() {
  local payload="$1"
  local output="$2"
  local file_count="$3"
  local wrapper_dir
  local payload_sha256

  wrapper_dir="$(mktemp -d "${work_dir}/wrapper.XXXXXX")"
  cp -- "${payload}" "${wrapper_dir}/data.tar.gz"
  payload_sha256="$(sha256sum "${wrapper_dir}/data.tar.gz" | cut -d ' ' -f 1)"
  printf '%s\n' \
    '{' \
    '  "formatVersion": 1,' \
    '  "createdAt": "2023-11-14T22:13:20Z",' \
    "  \"fileCount\": ${file_count}," \
    '  "keyIncluded": false,' \
    "  \"payloadSha256\": \"${payload_sha256}\"" \
    '}' >"${wrapper_dir}/manifest.json"
  tar --create --gzip --file "${output}" --directory "${wrapper_dir}" \
    manifest.json data.tar.gz
  rm -rf -- "${wrapper_dir}"
}

source_dir="${work_dir}/source"
restore_dir="${work_dir}/restore"
mkdir -p "${source_dir}/nested" "${restore_dir}"
printf 'alpha\n' >"${source_dir}/database.db"
printf 'beta\n' >"${source_dir}/nested/database.db-wal"

if "${repo_root}/tools/backup-data.sh" \
  "${source_dir}" "${work_dir}/not-quiesced.tar.gz" >/dev/null 2>&1; then
  echo "backup unexpectedly accepted a live data directory" >&2
  exit 1
fi

SOURCE_DATE_EPOCH=1700000000 \
  "${repo_root}/tools/backup-data.sh" --quiesced \
  "${source_dir}" "${work_dir}/backup-one.tar.gz"
SOURCE_DATE_EPOCH=1700000000 \
  "${repo_root}/tools/backup-data.sh" --quiesced \
  "${source_dir}" "${work_dir}/backup-two.tar.gz"
cmp "${work_dir}/backup-one.tar.gz" "${work_dir}/backup-two.tar.gz"

printf 'existing\n' >"${work_dir}/existing.tar.gz"
if "${repo_root}/tools/backup-data.sh" --quiesced \
  "${source_dir}" "${work_dir}/existing.tar.gz" >/dev/null 2>&1; then
  echo "backup unexpectedly replaced an existing archive" >&2
  exit 1
fi
grep --fixed-strings --quiet existing "${work_dir}/existing.tar.gz"

if "${repo_root}/tools/restore-data.sh" \
  "${work_dir}/backup-one.tar.gz" "${restore_dir}" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted a live data directory" >&2
  exit 1
fi

"${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/backup-one.tar.gz" "${restore_dir}"
cmp "${source_dir}/database.db" "${restore_dir}/database.db"
cmp "${source_dir}/nested/database.db-wal" "${restore_dir}/nested/database.db-wal"

if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/backup-one.tar.gz" "${restore_dir}" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted a non-empty target" >&2
  exit 1
fi

ln -s "${source_dir}/database.db" "${source_dir}/linked-key"
if "${repo_root}/tools/backup-data.sh" --quiesced \
  "${source_dir}" "${work_dir}/symlink.tar.gz" >/dev/null 2>&1; then
  echo "backup unexpectedly followed a symbolic link" >&2
  exit 1
fi
rm "${source_dir}/linked-key"

key_file="${source_dir}/sqlsimcity-storage-key"
printf 'not-a-real-key\n' >"${key_file}"
if "${repo_root}/tools/backup-data.sh" --quiesced --key-file "${key_file}" \
  "${source_dir}" "${work_dir}/key.tar.gz" >/dev/null 2>&1; then
  echo "backup unexpectedly included a key from the data directory" >&2
  exit 1
fi
rm "${key_file}"

key_file="${work_dir}/external-storage-key"
printf 'not-a-real-key\n' >"${key_file}"
ln "${key_file}" "${source_dir}/hard-linked-key"
if "${repo_root}/tools/backup-data.sh" --quiesced --key-file "${key_file}" \
  "${source_dir}" "${work_dir}/hard-link-key.tar.gz" >/dev/null 2>&1; then
  echo "backup unexpectedly included a hard link to the key file" >&2
  exit 1
fi
rm "${source_dir}/hard-linked-key"

tamper_dir="${work_dir}/tamper"
mkdir "${tamper_dir}"
tar --extract --gzip --file "${work_dir}/backup-one.tar.gz" --directory "${tamper_dir}"
printf 'tampered\n' >>"${tamper_dir}/data.tar.gz"
tar --create --gzip --file "${work_dir}/tampered.tar.gz" \
  --directory "${tamper_dir}" manifest.json data.tar.gz
mkdir "${work_dir}/tampered-restore"
if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/tampered.tar.gz" "${work_dir}/tampered-restore" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted a checksum mismatch" >&2
  exit 1
fi
if find "${work_dir}/tampered-restore" -mindepth 1 -print -quit | grep --quiet .; then
  echo "restore wrote to the target before checksum validation completed" >&2
  exit 1
fi

sed 's/"formatVersion": 1/"formatVersion": 10/' \
  "${tamper_dir}/manifest.json" >"${tamper_dir}/manifest-v10.json"
mv "${tamper_dir}/manifest-v10.json" "${tamper_dir}/manifest.json"
tar --create --gzip --file "${work_dir}/version-ten.tar.gz" \
  --directory "${tamper_dir}" manifest.json data.tar.gz
mkdir "${work_dir}/version-ten-restore"
if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/version-ten.tar.gz" "${work_dir}/version-ten-restore" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted an unsupported manifest version" >&2
  exit 1
fi

special_dir="${work_dir}/special"
special_wrapper="${work_dir}/special-wrapper"
mkdir "${special_dir}" "${special_wrapper}"
ln -s "${work_dir}/outside" "${special_dir}/unsafe-link"
tar --create --gzip --file "${special_wrapper}/data.tar.gz" \
  --directory "${special_dir}" .
special_sha="$(sha256sum "${special_wrapper}/data.tar.gz" | cut -d ' ' -f 1)"
printf '%s\n' \
  '{' \
  '  "formatVersion": 1,' \
  '  "createdAt": "2023-11-14T22:13:20Z",' \
  '  "fileCount": 0,' \
  '  "keyIncluded": false,' \
  "  \"payloadSha256\": \"${special_sha}\"" \
  '}' >"${special_wrapper}/manifest.json"
tar --create --gzip --file "${work_dir}/special.tar.gz" \
  --directory "${special_wrapper}" manifest.json data.tar.gz
mkdir "${work_dir}/special-restore"
if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/special.tar.gz" "${work_dir}/special-restore" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted a symbolic-link payload" >&2
  exit 1
fi

symlink_target="${work_dir}/symlink-target"
mkdir "${symlink_target}"
ln -s "${symlink_target}" "${work_dir}/restore-link"
if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/backup-one.tar.gz" "${work_dir}/restore-link" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted a symbolic-link target" >&2
  exit 1
fi

traversal_source="${work_dir}/traversal-source"
mkdir "${traversal_source}"
printf 'escape\n' >"${traversal_source}/safe"
tar --create --gzip --file "${work_dir}/traversal-payload.tar.gz" \
  --transform='s|^safe$|../escaped|' \
  --directory "${traversal_source}" safe
make_wrapper "${work_dir}/traversal-payload.tar.gz" \
  "${work_dir}/traversal-backup.tar.gz" 1
mkdir "${work_dir}/traversal-restore"
if "${repo_root}/tools/restore-data.sh" --quiesced \
  "${work_dir}/traversal-backup.tar.gz" "${work_dir}/traversal-restore" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted payload path traversal" >&2
  exit 1
fi
if [[ -e "${work_dir}/escaped" ]] ||
   find "${work_dir}/traversal-restore" -mindepth 1 -print -quit |
     grep --quiet .; then
  echo "path-traversal payload wrote during validation" >&2
  exit 1
fi

echo "operations tests passed"
