# Media sandbox image (Sprint 33)

```bash
docker build -t aegis-media-sandbox:local -f deploy/sandbox/Dockerfile.media .
export AEGIS_MEDIA_SANDBOX_IMAGE=aegis-media-sandbox:local
```

Used by `/media-transcode` and Telegram voice STT. Jobs run with `--network none`.

Optional: add whisper.cpp binary and model under `/models/` for production STT without `MEDIA_MOCK`.
