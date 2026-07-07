---
name: notes
description: Markdown notes in the workspace with undo (Obsidian-compatible)
---

# Notes (C7)

Notes are markdown files under `notes/` in the agent workspace. Every write is
backed up (trash + `/undo-file`), deletion is reversible, and the folder can be
opened directly as an Obsidian vault on the host.

## Procedures

- Create/append: `/write notes/<topic>.md | <content>`
- Read: `/read notes/<topic>.md`
- Undo last change: `/undo-file notes/<topic>.md`
- Remove (to trash): `/delete-file notes/<topic>.md`

## Conventions

- One topic per file, kebab-case names (`notes/meeting-prep.md`).
- Daily notes: `notes/daily/<YYYY-MM-DD>.md`.
- When the owner says "запиши/note this", append to the matching topic file and
  confirm with the file path.

## Provenance

Content saved from untrusted sources (fetched pages, forwarded messages) keeps
its quarantine provenance in episode metadata — saving to disk does not launder it.
