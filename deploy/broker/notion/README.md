# Notion broker secret (C7-Notion)

Place integration token in `token.txt` (single line, 0600).

`secret.yaml` mounts token for Envoy `credential_injector` on listener :8085.

OAuth-sidecar optional for future — v1 uses long-lived integration token.
