#!/bin/sh
# C9 (Sprint 28): детерминированный парсинг тел писем → журнал workspace/finance/.
set -eu
INPUT="${FINANCE_INPUT:-/workspace/finance/.ingest-buffer.txt}"
FIN_DIR="/workspace/finance"
PROCESSED="${FIN_DIR}/processed-ids.txt"
MONTH="${FINANCE_MONTH:-$(date +%Y-%m)}"
JOURNAL="${FIN_DIR}/${MONTH}.jsonl"

mkdir -p "${FIN_DIR}"
touch "${PROCESSED}"

if [ ! -s "${INPUT}" ]; then
  echo "FINANCE_OK: no new entries"
  exit 0
fi

added=0
current_id=""
buffer=""

flush_block() {
  [ -z "${current_id}" ] && return
  grep -qxF "${current_id}" "${PROCESSED}" 2>/dev/null && return
  amount=$(printf '%s' "${buffer}" | grep -oiE '[0-9]+[.,][0-9]{2}' | head -1 | tr ',' '.')
  [ -z "${amount}" ] && return
  merchant=$(printf '%s' "${buffer}" | sed -n 's/^Subject: //p' | head -1 | tr -d '\r')
  [ -z "${merchant}" ] && merchant="unknown"
  date_line=$(printf '%s' "${buffer}" | sed -n 's/^Date: //p' | head -1 | tr -d '\r')
  [ -z "${date_line}" ] && date_line=$(date -u +%Y-%m-%d)
  snippet=$(printf '%s' "${buffer}" | tr '\n' ' ' | head -c 120)
  esc_m=$(printf '%s' "${merchant}" | sed 's/"/\\"/g')
  esc_s=$(printf '%s' "${snippet}" | sed 's/"/\\"/g')
  printf '{"date":"%s","amount":%s,"currency":"?","merchant":"%s","source_msg_id":"%s","raw_snippet":"%s"}\n' \
    "${date_line}" "${amount}" "${esc_m}" "${current_id}" "${esc_s}" >> "${JOURNAL}"
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
  echo "FINANCE_OK: added ${added} entries"
else
  echo "FINANCE_OK: no new entries"
fi
