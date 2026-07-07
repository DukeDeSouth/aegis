# aegis-setup

Interactive installer for [AEGIS](https://github.com/your-org/aegis) self-hosted deployment.

**Not part of the trusted core** — this package only writes configuration files.

## Usage

From the monorepo root (after `npm ci`):

```bash
npm run setup              # interactive init
npm run setup -- init --yes --force
npm run setup -- verify
npm run setup -- upgrade
npm run setup -- connector list
npm run setup -- connector add weather rss
```

## Connectors (Sprint 23)

Presets live in `connectors/<name>/` at the repo root (`connector.json` +
`SKILL.md` + `manifest.json`). `connector add <name>`:

1. copies the declarative skill into `skills/<name>/`;
2. idempotently inserts broker routes into `deploy/broker/envoy.yaml`
   (marker `# connector:<name>`; second run is a no-op);
3. prints config hints (cron entries, `web.search_url`, compose services).

No secrets are handled by this wave; restart the broker container after adding routes.

### OAuth connectors (Sprint 24)

A preset may declare `broker_listener` in `connector.json` (port, `secret_name`,
`sds_path`, routes): `connector add` then inserts a **whole Envoy listener**
with its own `credential_injector` (marker `# connector:<name> listener`).
Used by `connectors/google` — routes on `:8081` get the OAuth token from the
SDS file that `deploy/broker/oauth-sidecar` refreshes (ADR-0010). Secrets stay
in files mounted to the sidecar/broker only; the wizard never touches them.

Or via bin:

```bash
npx aegis-setup init
```

## Generated files

| File | Purpose |
|------|---------|
| `aegis.config.json` | Core config (`*_ref` only, no secrets) |
| `.env.aegis` | Host env for `npm start` |
| `deploy/.env` | Docker Compose env |
| `deploy/docker-compose.yml` | Broker topology (pinned Envoy) |
| `deploy/broker/*` | Envoy config (from bundled templates) |
| `.aegis-setup.json` | Installer manifest |

## Security

- No `curl | bash`
- Broker API key → `deploy/broker/token.txt` (mode 600)
- Telegram token → `.env` files only

## Tests

```bash
npm test -w aegis-setup
```
