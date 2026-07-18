#!/bin/sh
# U1 (Sprint 33): transcribe voice file in workspace (wrapper over subtitles.sh logic).
set -eu
export INPUT_PATH="${INPUT_PATH:?}"
exec /bin/sh /skill/subtitles.sh
