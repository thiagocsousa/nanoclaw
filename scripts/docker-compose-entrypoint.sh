#!/bin/bash
set -euo pipefail

: "${NANOCLAW_ROOT:?Set NANOCLAW_ROOT to the absolute host path of this repository}"

if [[ "${NANOCLAW_ROOT}" != /* ]]; then
  echo "NANOCLAW_ROOT must be an absolute path: ${NANOCLAW_ROOT}" >&2
  exit 1
fi

cd "${NANOCLAW_ROOT}"

if [[ ! -f package.json ]]; then
  echo "package.json not found under ${NANOCLAW_ROOT}" >&2
  exit 1
fi

mkdir -p data store groups logs

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not reachable from the NanoClaw container" >&2
  exit 1
fi

ensure_node_modules() {
  local current_lock=""
  local recorded_lock=""
  local stamp_file="node_modules/.package-lock.sha256"

  if [[ -f package-lock.json ]]; then
    current_lock="$(sha256sum package-lock.json | awk '{print $1}')"
    if [[ -f "${stamp_file}" ]]; then
      recorded_lock="$(cat "${stamp_file}")"
    fi
  fi

  if [[ ! -x node_modules/.bin/tsc || "${current_lock}" != "${recorded_lock}" ]]; then
    npm install
    if [[ -n "${current_lock}" ]]; then
      printf '%s\n' "${current_lock}" > "${stamp_file}"
    fi
  fi
}

needs_app_build() {
  if [[ ! -f dist/index.js ]]; then
    return 0
  fi

  if find src package.json tsconfig.json -newer dist/index.js -print -quit | grep -q .; then
    return 0
  fi

  return 1
}

ensure_agent_image() {
  local stamp_file="data/.nanoclaw-agent.sha256"
  local current_hash=""
  local recorded_hash=""

  current_hash="$(
    find container -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )"

  if [[ -f "${stamp_file}" ]]; then
    recorded_hash="$(cat "${stamp_file}")"
  fi

  if ! docker image inspect nanoclaw-agent:latest >/dev/null 2>&1 || [[ "${current_hash}" != "${recorded_hash}" ]]; then
    bash container/build.sh
    printf '%s\n' "${current_hash}" > "${stamp_file}"
  fi
}

ensure_node_modules

if needs_app_build; then
  npm run build
fi

ensure_agent_image

exec npm start
