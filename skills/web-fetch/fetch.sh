#!/bin/sh
# F2: HTTP GET через broker (Host = целевой сайт). Вывод — plain text, не сырой HTML.
set -eu
HOST="${TARGET_HOST:?}"
PATH_PART="${TARGET_PATH:-/}"
BROKER="${BROKER_HOST:?}"
MAX="${MAX_BYTES:-524288}"

wget -qO- -T 15 --header="Host: ${HOST}" "http://${BROKER}${PATH_PART}" \
  | sed 's/<script[^>]*>.*<\/script>//g; s/<style[^>]*>.*<\/style>//g; s/<[^>]*>//g' \
  | tr -s ' \n' ' ' \
  | head -c "${MAX}"
