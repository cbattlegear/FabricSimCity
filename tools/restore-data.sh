#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 3 || "$1" != "--quiesced" ]]; then
  echo "usage: $0 --quiesced <backup-file> <empty-data-directory>" >&2
  exit 64
fi
shift

for command in chown find gzip realpath sha256sum stat tar; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command not found: ${command}" >&2
    exit 69
  fi
done

if [[ -L "$1" || -L "$2" ]]; then
  echo "backup and restore target must not be symbolic links" >&2
  exit 65
fi
backup_file="$(realpath -e -- "$1")"
target_dir="$(realpath -e -- "$2")"
if [[ ! -f "${backup_file}" || ! -d "${target_dir}" ]]; then
  echo "backup must be a file and restore target must be an existing directory" >&2
  exit 66
fi
if find "${target_dir}" -mindepth 1 -print -quit | grep --quiet .; then
  echo "restore target is not empty" >&2
  exit 65
fi

target_parent="$(dirname -- "${target_dir}")"
work_dir="$(mktemp -d "${target_parent}/.sqlsimcity-restore-work.XXXXXX")"
staging_dir="$(mktemp -d "${target_parent}/.sqlsimcity-restore-data.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
  if [[ -n "${staging_dir}" ]]; then
    rm -rf -- "${staging_dir}"
  fi
}
trap cleanup EXIT
target_uid="$(stat --format='%u' "${target_dir}")"
target_gid="$(stat --format='%g' "${target_dir}")"
chmod --reference="${target_dir}" "${staging_dir}"

tar --list --gzip --file "${backup_file}" >"${work_dir}/outer-members.txt"
tar --list --verbose --gzip --file "${backup_file}" >"${work_dir}/outer-listing.txt"
mapfile -t outer_members <"${work_dir}/outer-members.txt"
if [[ "${#outer_members[@]}" -ne 2 ||
      "${outer_members[0]}" != "manifest.json" ||
      "${outer_members[1]}" != "data.tar.gz" ]]; then
  echo "backup wrapper contains unexpected paths" >&2
  exit 65
fi
while IFS= read -r listing; do
  if [[ "${listing:0:1}" != "-" ]]; then
    echo "backup wrapper contains a link or special file" >&2
    exit 65
  fi
done <"${work_dir}/outer-listing.txt"
tar --extract --gzip --file "${backup_file}" --directory "${work_dir}" \
  --no-same-owner --no-same-permissions

mapfile -t manifest <"${work_dir}/manifest.json"
if [[ "${#manifest[@]}" -ne 7 ||
      "${manifest[0]}" != "{" ||
      "${manifest[1]}" != '  "formatVersion": 1,' ||
      ! "${manifest[2]}" =~ ^'  "createdAt": "'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'Z",'$ ||
      ! "${manifest[3]}" =~ ^'  "fileCount": '[0-9]+','$ ||
      "${manifest[4]}" != '  "keyIncluded": false,' ||
      ! "${manifest[5]}" =~ ^'  "payloadSha256": "'[0-9a-f]{64}'"'$ ||
      "${manifest[6]}" != "}" ]]; then
  echo "unsupported or unsafe backup manifest" >&2
  exit 65
fi
expected_file_count="${manifest[3]#*: }"
expected_file_count="${expected_file_count%,}"
expected_sha256="$(printf '%s\n' "${manifest[5]}" | cut -d '"' -f 4)"
actual_sha256="$(sha256sum "${work_dir}/data.tar.gz" | cut -d ' ' -f 1)"
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
  echo "backup payload checksum mismatch" >&2
  exit 65
fi

tar --list --gzip --file "${work_dir}/data.tar.gz" >"${work_dir}/payload-members.txt"
tar --list --verbose --gzip --file "${work_dir}/data.tar.gz" >"${work_dir}/payload-listing.txt"
while IFS= read -r entry; do
  if [[ "${entry}" == /* || "${entry}" == *\\* ]]; then
    echo "backup payload contains an unsafe path" >&2
    exit 65
  fi
  case "/${entry}/" in
    *"/../"*)
      echo "backup payload contains path traversal" >&2
      exit 65
      ;;
  esac
done <"${work_dir}/payload-members.txt"

actual_file_count=0
while IFS= read -r listing; do
  case "${listing:0:1}" in
    -)
      actual_file_count="$((actual_file_count + 1))"
      ;;
    d)
      ;;
    *)
      echo "backup payload contains a link or special file" >&2
      exit 65
      ;;
  esac
done <"${work_dir}/payload-listing.txt"
if [[ "${actual_file_count}" -ne "${expected_file_count}" ]]; then
  echo "backup payload file count does not match its manifest" >&2
  exit 65
fi

tar --extract --gzip --file "${work_dir}/data.tar.gz" \
  --directory "${staging_dir}" \
  --no-same-owner \
  --no-same-permissions
chown --recursive "${target_uid}:${target_gid}" "${staging_dir}"

if [[ ! -d "${target_dir}" || -L "${target_dir}" ]] ||
   find "${target_dir}" -mindepth 1 -print -quit | grep --quiet .; then
  echo "restore target changed or is no longer empty" >&2
  exit 65
fi
mv --no-target-directory -- "${staging_dir}" "${target_dir}"
staging_dir=""

echo "restore completed: ${target_dir}"
