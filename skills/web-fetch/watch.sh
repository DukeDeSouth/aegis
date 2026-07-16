#!/bin/sh
# C8 (Sprint 26): fetch + diff against workspace snapshot (price/page watch).
set -eu
HOST="${TARGET_HOST:?}"
PATH_PART="${TARGET_PATH:-/}"
BROKER="${BROKER_HOST:?}"
MAX="${MAX_BYTES:-524288}"
WATCH_DIR="${WATCH_DIR:-/workspace/watch}"
URL_KEY="${WATCH_URL:-https://${HOST}${PATH_PART}}"

mkdir -p "${WATCH_DIR}"
HASH=$(printf '%s' "${URL_KEY}" | sha256sum 2>/dev/null | awk '{print $1}')
if [ -z "${HASH}" ]; then
  HASH=$(printf '%s' "${URL_KEY}" | shasum -a 256 2>/dev/null | awk '{print $1}')
fi
PREV="${WATCH_DIR}/${HASH}.digest"
TMP="/tmp/watch-body.$$"
NORM="/tmp/watch-norm.$$"
trap 'rm -f "${TMP}" "${NORM}"' EXIT

wget -qO "${TMP}" -T 15 --header="Host: ${HOST}" "http://${BROKER}${PATH_PART}"

if head -c 512 "${TMP}" | grep -qiE '<(rss|feed)[ >]'; then
  tr -d '\n' < "${TMP}" \
    | sed 's/<!\[CDATA\[//g; s/\]\]>//g' \
    | sed 's/<item[ >]/\n<item>/g; s/<entry[ >]/\n<entry>/g' \
    | sed -n 's/.*<title[^>]*>\([^<]*\)<\/title>.*<link[^>]*href="\([^"]*\)".*/\1 — \2/p; s/.*<title[^>]*>\([^<]*\)<\/title>.*<link[^>]*>\([^<]*\)<\/link>.*/\1 — \2/p' \
    | head -c "${MAX}" > "${NORM}"
else
  sed 's/<script[^>]*>.*<\/script>//g; s/<style[^>]*>.*<\/style>//g; s/<[^>]*>//g' "${TMP}" \
    | tr -s ' \n' ' ' \
    | head -c "${MAX}" > "${NORM}"
fi

if [ ! -f "${PREV}" ]; then
  cp "${NORM}" "${PREV}"
  echo "WATCH_OK: baseline saved (${URL_KEY})"
  exit 0
fi

if cmp -s "${NORM}" "${PREV}"; then
  echo "WATCH_OK: unchanged"
  exit 0
fi

OLD_PRICE=$(grep -oE '[0-9]+[.,][0-9]{2}' "${PREV}" | head -1 || true)
NEW_PRICE=$(grep -oE '[0-9]+[.,][0-9]{2}' "${NORM}" | head -1 || true)
cp "${NORM}" "${PREV}"

if [ -n "${NEW_PRICE}" ] && [ -n "${OLD_PRICE}" ] && [ "${NEW_PRICE}" != "${OLD_PRICE}" ]; then
  echo "WATCH_CHANGED: price ${OLD_PRICE} → ${NEW_PRICE} (${URL_KEY})"
else
  echo "WATCH_CHANGED: page content changed (${URL_KEY})"
fi
