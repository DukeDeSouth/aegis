#!/bin/sh
# C14 (Sprint 33): local ffmpeg transcode — YouTube / TikTok / Shorts presets.
set -eu
REL="${INPUT_PATH:?}"
IN="/workspace/${REL}"
if [ ! -f "${IN}" ]; then
  echo "MEDIA_ERROR: input not found: ${REL}" >&2
  exit 1
fi
BASE=$(basename "${REL}")
BASE="${BASE%.*}"
OUT="/workspace/media/out/${BASE}"
mkdir -p "${OUT}"

if [ "${MEDIA_MOCK:-}" = "1" ]; then
  : > "${OUT}/youtube_16x9.mp4"
  : > "${OUT}/tiktok_9x16.mp4"
  : > "${OUT}/shorts_60s.mp4"
  echo "MEDIA_OK: ${OUT}/youtube_16x9.mp4 ${OUT}/tiktok_9x16.mp4 ${OUT}/shorts_60s.mp4"
  exit 0
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "MEDIA_ERROR: ffmpeg not available in sandbox image" >&2
  exit 1
fi

ffmpeg -y -hide_banner -loglevel error -i "${IN}" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k \
  "${OUT}/youtube_16x9.mp4"

ffmpeg -y -hide_banner -loglevel error -i "${IN}" \
  -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k \
  "${OUT}/tiktok_9x16.mp4"

ffmpeg -y -hide_banner -loglevel error -t 60 -i "${IN}" \
  -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k \
  "${OUT}/shorts_60s.mp4"

echo "MEDIA_OK: ${OUT}/youtube_16x9.mp4 ${OUT}/tiktok_9x16.mp4 ${OUT}/shorts_60s.mp4"
