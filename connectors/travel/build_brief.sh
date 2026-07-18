#!/bin/sh
# C20: сводка workspace/travel/brief.md из bookings + flight cache.
set -eu
TRAVEL_DIR="/workspace/travel"
JOURNAL="${TRAVEL_DIR}/bookings.jsonl"
BRIEF="${TRAVEL_DIR}/brief.md"

mkdir -p "${TRAVEL_DIR}"

count=0
if [ -f "${JOURNAL}" ]; then
  count=$(wc -l < "${JOURNAL}" | tr -d ' ')
fi

{
  echo "# Travel brief"
  echo ""
  echo "Generated: $(date -u +%Y-%m-%dT%H:%MZ)"
  echo ""
  echo "## Bookings (${count})"
  echo ""

  if [ "${count}" -eq 0 ]; then
    echo "_No bookings yet — run /travel-ingest._"
  else
    while IFS= read -r line; do
      kind=$(printf '%s' "${line}" | sed -n 's/.*"kind":"\([^"]*\)".*/\1/p')
      subj=$(printf '%s' "${line}" | sed -n 's/.*"subject":"\([^"]*\)".*/\1/p')
      fl=$(printf '%s' "${line}" | sed -n 's/.*"flight_iata":"\([^"]*\)".*/\1/p')
      hotel=$(printf '%s' "${line}" | sed -n 's/.*"hotel":"\([^"]*\)".*/\1/p')
      checkin=$(printf '%s' "${line}" | sed -n 's/.*"checkin":"\([^"]*\)".*/\1/p')
      echo "- **${kind}**: ${subj}"
      [ -n "${fl}" ] && echo "  - Flight: ${fl}"
      [ -n "${hotel}" ] && echo "  - Hotel: ${hotel}"
      [ -n "${checkin}" ] && echo "  - Check-in: ${checkin}"
      if [ -n "${fl}" ] && [ -f "${TRAVEL_DIR}/flight-${fl}.json" ]; then
        st=$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "${TRAVEL_DIR}/flight-${fl}.json")
        dep=$(sed -n 's/.*"departure":"\([^"]*\)".*/\1/p' "${TRAVEL_DIR}/flight-${fl}.json")
        echo "  - Status: ${st} (dep ${dep})"
      fi
      echo ""
    done < "${JOURNAL}"
  fi
} > "${BRIEF}"

echo "TRAVEL_BRIEF: ${count} bookings, brief at workspace/travel/brief.md"
