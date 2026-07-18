# gVisor (runsc) sandbox runtime

Опциональное усиление V3 (ADR-0006, Sprint 40): вместо shared-kernel Docker контейнеры исполняются через **gVisor** (`runsc`) — user-space kernel, drop-in runtime для Docker на **Linux**.

По умолчанию AEGIS использует hardened Docker (`sandbox.runtime: docker`). gVisor — opt-in.

## Требования

- Linux x86_64 или arm64 (не macOS — там Docker уже в VM)
- Docker Engine ≥ 20.10
- [gVisor](https://gvisor.dev/docs/user_guide/install/) установлен и зарегистрирован как runtime `runsc`

## Установка runsc (пример)

```bash
# Официальный скрипт (проверьте checksum на gvisor.dev):
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
curl -fsSL https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc \
  | sudo tee /usr/local/bin/runsc > /dev/null && sudo chmod +x /usr/local/bin/runsc

sudo runsc install
sudo systemctl restart docker
docker run --rm --runtime runsc alpine:3.20 true
```

## Регистрация в Docker

См. [`daemon.json.example`](./daemon.json.example). После правки `/etc/docker/daemon.json`:

```bash
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}' | jq 'has("runsc")'
```

## Конфиг AEGIS

В `aegis.config.json`:

```json
{
  "sandbox": {
    "runtime": "gvisor",
    "workspace_dir": "./workspace"
  }
}
```

Проверка: `aegis-setup verify` — при `runtime=gvisor` выполняет smoke `docker run --runtime runsc`.

## Ограничения

- Небольшой overhead на syscall; часть редких syscalls может отличаться от runc
- Сеть и volume-флаги AEGIS (hardened profile) совместимы; полный прогон — `test/security/v3-gvisor-runtime.test.ts`
- **Firecracker / Kata** — отдельный upgrade-path (Sprint 41+), не входит в S2

## Ссылки

- ADR-0006 — upgrade-path gVisor first
- ADR-0028 — LOC budget Sprint 40
- `docs/DEPLOYMENT.md` — раздел gVisor
