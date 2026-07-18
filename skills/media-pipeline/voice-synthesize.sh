#!/bin/sh
# U2 (Sprint 36): TTS → OGG in workspace (piper or espeak-ng + ffmpeg).
set -eu
TEXT="${TEXT:?}"
OUTPUT_REL="${OUTPUT_REL:?}"
OUT="/workspace/${OUTPUT_REL}"
mkdir -p "$(dirname "$OUT")"

if [ "${MEDIA_MOCK:-}" = "1" ]; then
  printf 'OggS' > "$OUT"
  exit 0
fi

WAV="/tmp/tts-$$.wav"
trap 'rm -f "$WAV"' EXIT

if command -v piper >/dev/null 2>&1 && [ -f "${PIPER_MODEL:-/models/en_US-lessac-medium.onnx}" ]; then
  printf '%s' "$TEXT" | piper --model "${PIPER_MODEL}" --output_file "$WAV"
elif command -v espeak-ng >/dev/null 2>&1; then
  espeak-ng -w "$WAV" "$TEXT"
else
  echo "TTS_ERROR: no TTS engine (piper or espeak-ng)" >&2
  exit 1
fi

ffmpeg -y -hide_banner -loglevel error -i "$WAV" -c:a libopus "$OUT"
