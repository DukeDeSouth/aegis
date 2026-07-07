#!/bin/sh
# F2: HTTP GET через broker (Host = целевой сайт). Вывод — plain text, не сырой HTML.
# C6 (Sprint 23): RSS/Atom-фиды выжимаются в список "title — link" до карантина.
set -eu
HOST="${TARGET_HOST:?}"
PATH_PART="${TARGET_PATH:-/}"
BROKER="${BROKER_HOST:?}"
MAX="${MAX_BYTES:-524288}"

BODY_FILE="/tmp/fetch-body.$$"
trap 'rm -f "${BODY_FILE}"' EXIT
wget -qO "${BODY_FILE}" -T 15 --header="Host: ${HOST}" "http://${BROKER}${PATH_PART}"

if head -c 512 "${BODY_FILE}" | grep -qiE '<(rss|feed)[ >]'; then
  # RSS/Atom: только заголовки и ссылки, по строке на элемент.
  tr -d '\n' < "${BODY_FILE}" \
    | sed 's/<!\[CDATA\[//g; s/\]\]>//g' \
    | sed 's/<item[ >]/\n<item>/g; s/<entry[ >]/\n<entry>/g' \
    | sed -n 's/.*<title[^>]*>\([^<]*\)<\/title>.*<link[^>]*href="\([^"]*\)".*/\1 — \2/p; s/.*<title[^>]*>\([^<]*\)<\/title>.*<link[^>]*>\([^<]*\)<\/link>.*/\1 — \2/p' \
    | head -c "${MAX}"
else
  sed 's/<script[^>]*>.*<\/script>//g; s/<style[^>]*>.*<\/style>//g; s/<[^>]*>//g' "${BODY_FILE}" \
    | tr -s ' \n' ' ' \
    | head -c "${MAX}"
fi
