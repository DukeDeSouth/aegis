# Postiz broker listener (:8086)

`secret.yaml` mounts API key for Envoy `credential_injector` on listener :8086.

Postiz expects `Authorization: <api-key>` (no Bearer prefix). The social connector sets `header_value_prefix: ""` in `connector.json`.

1. Copy `secret.yaml` to broker SDS path (or merge into your SDS layout).
2. Create `api-key.txt` with your Postiz Public API key (mode 0600).
3. Set `cluster_address` / `cluster_port` in envoy route to your Postiz backend.
4. `aegis-setup connector add social`

Postiz platform OAuth (X, LinkedIn, …) is configured in Postiz UI — not in AEGIS.
