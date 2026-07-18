#!/bin/sh
# C20: детерминированный парсинг travel-писем → workspace/travel/bookings.jsonl.
set -eu
INPUT="${TRAVEL_INPUT:-/workspace/travel/.ingest-buffer.txt}"
TRAVEL_DIR="/workspace/travel"
PROCESSED="${TRAVEL_DIR}/processed-ids.txt"
JOURNAL="${TRAVEL_DIR}/bookings.jsonl"

mkdir -p "${TRAVEL_DIR}"
touch "${PROCESSED}"

if [ ! -s "${INPUT}" ]; then
  echo "TRAVEL_OK: no new entries"
  exit 0
fi

added=0
current_id=""
buffer=""

json_esc() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

flush_block() {
  [ -z "${current_id}" ] && return
  grep -qxF "${current_id}" "${PROCESSED}" 2>/dev/null && return

  subject=$(printf '%s' "${buffer}" | sed -n 's/^Subject: //p' | head -1 | tr -d '\r')
  [ -z "${subject}" ] && subject="unknown"
  date_line=$(printf '%s' "${buffer}" | sed -n 's/^Date: //p' | head -1 | tr -d '\r')
  [ -z "${date_line}" ] && date_line=$(date -u +%Y-%m-%d)
  snippet=$(printf '%s' "${buffer}" | tr '\n' ' ' | head -c 160)

  kind="booking"
  flight=""
  hotel=""
  checkin=""

  if printf '%s' "${buffer}" | grep -qiE 'flight|рейс|boarding|вылет'; then
    kind="flight"
  fi
  if printf '%s' "${buffer}" | grep -qiE 'hotel|отель|accommodation'; then
    kind="hotel"
    hotel=$(printf '%s' "${subject}" | sed 's/confirmation//i; s/booking//i' | tr -d '\r' | head -c 80)
  fi

  flight=$(printf '%s' "${buffer}${subject}" | grep -oE '[A-Z]{2}[0-9]{1,4}|[A-Z][0-9]{1,4}[A-Z]' | head -1)
  checkin=$(printf '%s' "${buffer}" | grep -oiE 'check-?in:?\s*[0-9]{1,2}[^0-9][A-Za-z]{3}[^0-9][0-9]{4}' | head -1 | sed 's/.*: *//i')

  esc_s=$(json_esc "${subject}")
  esc_h=$(json_esc "${hotel}")
  esc_sn=$(json_esc "${snippet}")
  esc_ci=$(json_esc "${checkin}")
  esc_fl=$(json_esc "${flight}")

  printf '{"kind":"%s","subject":"%s","date":"%s","flight_iata":"%s","hotel":"%s","checkin":"%s","source_msg_id":"%s","raw_snippet":"%s"}\n' \
    "${kind}" "${esc_s}" "${date_line}" "${esc_fl}" "${esc_h}" "${esc_ci}" "${current_id}" "${esc_sn}" >> "${JOURNAL}"
  printf '%s\n' "${current_id}" >> "${PROCESSED}"
  added=$((added + 1))
}

while IFS= read -r line || [ -n "${line}" ]; do
  case "${line}" in
    ---MSG\ *---)
      flush_block
      current_id=$(printf '%s' "${line}" | sed 's/^---MSG \(.*\)---$/\1/')
      buffer=""
      ;;
    *)
      buffer="${buffer}${line}
"
      ;;
  esac
done < "${INPUT}"
flush_block

if [ "${added}" -gt 0 ]; then
  echo "TRAVEL_OK: added ${added} entries"
else
  echo "TRAVEL_OK: no new entries"
fi
