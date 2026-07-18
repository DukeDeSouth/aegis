#!/bin/sh
# C14/U1 (Sprint 33): STT via whisper.cpp or mock for tests.
set -eu
REL="${INPUT_PATH:?}"
IN="/workspace/${REL}"
if [ ! -f "${IN}" ]; then
  echo "STT_ERROR: input not found: ${REL}" >&2
  exit 1
fi

if [ "${MEDIA_MOCK:-}" = "1" ]; then
  echo "${MOCK_TRANSCRIPT:-hello from media mock}"
  exit 0
fi

OUT_DIR=$(dirname "${IN}")
BASE=$(basename "${REL}")
BASE="${BASE%.*}"
SRT="${OUT_DIR}/${BASE}.srt"
WAV="/tmp/stt-$$.wav"
trap 'rm -f "${WAV}"' EXIT

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "STT_ERROR: ffmpeg not available" >&2
  exit 1
fi

ffmpeg -y -hide_banner -loglevel error -i "${IN}" -ar 16000 -ac 1 -c:a pcm_s16le "${WAV}"

if command -v whisper-cli >/dev/null 2>&1; then
  whisper-cli -m "${WHISPER_MODEL:-/models/ggml-base.bin}" -f "${WAV}" -osrt -of "${OUT_DIR}/${BASE}"
  if [ -f "${SRT}" ]; then
    cat "${SRT}"
    exit 0
  fi
fi

echo "STT_ERROR: whisper-cli not available; set MEDIA_MOCK=1 for tests" >&2
exit 1
