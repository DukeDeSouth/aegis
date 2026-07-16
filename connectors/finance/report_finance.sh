#!/bin/sh
# C9 (Sprint 28): месячный отчёт из JSONL-журнала (без LLM).
set -eu
FIN_DIR="/workspace/finance"
MONTH="${FINANCE_MONTH:-$(date +%Y-%m)}"
JOURNAL="${FIN_DIR}/${MONTH}.jsonl"

if [ ! -f "${JOURNAL}" ]; then
  echo "FINANCE_REPORT: ${MONTH}: 0 entries, total 0"
  exit 0
fi

total=0
count=0
while IFS= read -r line; do
  [ -z "${line}" ] && continue
  amt=$(printf '%s' "${line}" | sed -n 's/.*"amount":\([0-9.]*\).*/\1/p')
  [ -z "${amt}" ] && continue
  total=$(awk -v a="${total}" -v b="${amt}" 'BEGIN{printf "%.2f", a+b}')
  count=$((count + 1))
done < "${JOURNAL}"

echo "FINANCE_REPORT: ${MONTH}: ${count} entries, total ${total}"
