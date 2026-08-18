#!/usr/bin/env bash
set -Eeuo pipefail

for image in sqlsimcity:local sqlsimcity-edge:local; do
  license="$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}')"
  if [[ "$license" != "Apache-2.0" ]]; then
    echo "$image has unexpected OCI license label: $license" >&2
    exit 1
  fi
  docker run --rm --entrypoint sh "$image" -c \
    'test -f /app/legal/LICENSE && test -f /app/legal/NOTICE'
done

echo "Both runtime images declare Apache-2.0 and contain LICENSE/NOTICE."
