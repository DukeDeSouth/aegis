---
name: media-pipeline
description: Local video transcode and STT (ffmpeg + whisper) in sandbox
---

# Media pipeline (C14 / U1)

Process video **locally** in sandbox — no network egress.

## Commands

- `/media-transcode <workspace-path>` — YouTube 16:9, TikTok 9:16, Shorts ≤60s
- `/media-transcode <path> --subs` — same + `.srt` subtitles

Input must live under `workspace/` (e.g. `media/in/clip.mp4`).
Outputs: `workspace/media/out/<basename>/`.

## Voice (Telegram)

Send a voice note when STT is configured — transcript goes through quarantine (V1).

**Voice replies (U2):** `/voice-reply on` or say «ответь голосом» — agent replies with a voice message (local TTS in media sandbox, Telegram only v1).

## Sandbox image

Build `deploy/sandbox/Dockerfile.media` and set `AEGIS_MEDIA_SANDBOX_IMAGE`.
