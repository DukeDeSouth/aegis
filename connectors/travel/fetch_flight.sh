#!/bin/sh
# C20: flight status via broker listener travel.local → travel-proxy (aviationstack).
set -eu
IATA="${TRAVEL_FLIGHT_IATA:?}"
TRAVEL_DIR="/workspace/travel"
OUT="${TRAVEL_DIR}/flight-${IATA}.json"

mkdir -p "${TRAVEL_DIR}"

if [ "${TRAVEL_MOCK:-}" = "1" ]; then
  printf '{"flight_iata":"%s","status":"scheduled","departure":"2026-07-18T10:00:00+00:00","arrival":"2026-07-18T14:00:00+00:00","airline":"mock"}\n' \
    "${IATA}" > "${OUT}"
  echo "TRAVEL_FLIGHT_OK: mock saved ${OUT}"
  exit 0
fi

BROKER="${TRAVEL_BROKER_HOST:-${BROKER_HOST:?}}"
BODY="/tmp/flight-body.$$"
trap 'rm -f "${BODY}"' EXIT

if ! wget -qO "${BODY}" -T 25 --header="Host: travel.local" \
  "http://${BROKER}/v1/flights?flight_iata=${IATA}"; then
  echo "TRAVEL_FLIGHT_ERROR: broker fetch failed (configure travel-proxy + api-key)"
  exit 1
fi

if grep -q '"error"' "${BODY}" 2>/dev/null; then
  err=$(grep -o '"message":"[^"]*"' "${BODY}" | head -1 | cut -d'"' -f4)
  echo "TRAVEL_FLIGHT_ERROR: ${err:-api error}"
  exit 1
fi

status=$(grep -o '"flight_status":"[^"]*"' "${BODY}" | head -1 | cut -d'"' -f4)
dep=$(grep -o '"scheduled_departure":"[^"]*"' "${BODY}" | head -1 | cut -d'"' -f4)
arr=$(grep -o '"scheduled_arrival":"[^"]*"' "${BODY}" | head -1 | cut -d'"' -f4)
airline=$(grep -o '"airline_name":"[^"]*"' "${BODY}" | head -1 | cut -d'"' -f4)

printf '{"flight_iata":"%s","status":"%s","departure":"%s","arrival":"%s","airline":"%s"}\n' \
  "${IATA}" "${status:-unknown}" "${dep:-}" "${arr:-}" "${airline:-}" > "${OUT}"
echo "TRAVEL_FLIGHT_OK: ${IATA} saved ${OUT}"
