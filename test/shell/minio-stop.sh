#!/usr/bin/env bash
# Stop (and optionally remove) the throwaway MinIO container.
set -euo pipefail

NAME="${LWS_MINIO_NAME:-lws-minio}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "No container engine (docker/podman) available." >&2
  exit 1
fi

if $ENGINE ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  $ENGINE stop "${NAME}" >/dev/null
  if [[ "${1:-}" == "--rm" ]]; then
    $ENGINE rm "${NAME}" >/dev/null
  fi
fi
echo "MinIO stopped."
