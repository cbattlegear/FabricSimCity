#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 --quiesced <data-directory> <backup-file>" >&2
}

quiesced=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --quiesced)
      quiesced=true
      shift
      ;;
    --*)
      usage
      exit 64
      ;;
    *)
      break
      ;;
  esac
done

if [[ "${quiesced}" != true || "$#" -ne 2 ]]; then
  usage
  exit 64
fi

for command in find gzip realpath sha256sum tar; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 69
  fi
done

if [[ -L "$1" ]]; then
  echo "data directory must not be a symbolic link" >&2
  exit 65
fi
source_dir="$(realpath -e -- "$1")"
if [[ ! -d "${source_dir}" ]]; then
  echo "data directory is not a directory: ${source_dir}" >&2
  exit 66
fi
if find "${source_dir}" -type l -print -quit | grep --quiet .; then
  echo "data directory contains a symbolic link; backup refused" >&2
  exit 65
fi
if find "${source_dir}" ! -type d ! -type f -print -quit | grep --quiet .; then
  echo "data directory contains a special file; backup refused" >&2
  exit 65
fi
if find "${source_dir}" -name $'*\n*' -print -quit | grep --quiet .; then
  echo "data directory contains a newline in a path; backup refused" >&2
  exit 65
fi
while IFS= read -r -d '' relative_path; do
  if [[ "${relative_path}" == *\\* ]]; then
    echo "data directory contains a backslash in a path; backup refused" >&2
    exit 65
  fi
done < <(find "${source_dir}" -mindepth 1 -printf '%P\0')

output_parent="$(realpath -e -- "$(dirname -- "$2")")"
output_name="$(basename -- "$2")"
if [[ "${output_name}" == "." || "${output_name}" == ".." ]]; then
  echo "backup file must name a file in an existing directory" >&2
  exit 65
fi
output_file="${output_parent}/${output_name}"
case "${output_file}" in
  "${source_dir}"|"${source_dir}"/*)
    echo "backup file must be outside the data directory" >&2
    exit 65
    ;;
esac
if [[ -e "${output_file}" || -L "${output_file}" ]]; then
  echo "backup file already exists; use a new versioned filename" >&2
  exit 73
fi

work_dir="$(mktemp -d "${output_parent}/.sqlsimcity-backup.XXXXXX")"
temporary_output="$(mktemp "${output_parent}/.sqlsimcity-backup-output.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
  rm -f -- "${temporary_output}"
}
trap cleanup EXIT

epoch="${SOURCE_DATE_EPOCH:-$(date +%s)}"
created_at="$(date --utc --date="@${epoch}" '+%Y-%m-%dT%H:%M:%SZ')"
file_count="$(find "${source_dir}" -type f | wc -l | tr -d '[:space:]')"

tar --create \
  --file - \
  --directory "${source_dir}" \
  --sort=name \
  --mtime="@${epoch}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --hard-dereference \
  --format=pax \
  --pax-option=delete=atime,delete=ctime \
  . | gzip --no-name >"${work_dir}/data.tar.gz"

payload_sha256="$(sha256sum "${work_dir}/data.tar.gz" | cut -d ' ' -f 1)"
# "keyIncluded" is a fixed field of the version 1 manifest that restore-data.sh
# matches line for line. Protected storage no longer has a key at all, so the
# value is now a statement of fact about the product rather than about this run.
printf '%s\n' \
  '{' \
  '  "formatVersion": 1,' \
  "  \"createdAt\": \"${created_at}\"," \
  "  \"fileCount\": ${file_count}," \
  '  "keyIncluded": false,' \
  "  \"payloadSha256\": \"${payload_sha256}\"" \
  '}' >"${work_dir}/manifest.json"

tar --create \
  --file - \
  --directory "${work_dir}" \
  --sort=name \
  --mtime="@${epoch}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --format=ustar \
  manifest.json data.tar.gz | gzip --no-name >"${temporary_output}"

chmod 600 "${temporary_output}"
mv --no-clobber --no-target-directory -- "${temporary_output}" "${output_file}"
if [[ -e "${temporary_output}" ]]; then
  echo "backup file appeared while the archive was being created" >&2
  exit 73
fi
echo "backup written: ${output_file}"
