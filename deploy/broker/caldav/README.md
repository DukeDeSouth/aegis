# CalDAV broker secret (C7-CalDAV)

Create `basic.txt` with `username:password` (HTTP Basic for CalDAV).

SDS file `secret.yaml` references this file — same pattern as Home Assistant token.

Update `cluster_address` in merged envoy to your Nextcloud IP/hostname.
