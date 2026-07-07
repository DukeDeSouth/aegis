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
```

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
