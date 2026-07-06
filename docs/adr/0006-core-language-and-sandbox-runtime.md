# 0006. Язык ядра — TypeScript; рантайм sandbox — hardened Docker

- **Статус:** Accepted
- **Дата:** 2026-07-05

## Контекст

ARCHITECTURE.md оставлял язык ядра открытым (кандидаты: TypeScript для скорости разработки; Rust/Go для broker) и рантайм sandbox — «готовые кирпичи» без выбора. Исследование (июль 2026) сняло главную развилку: класс готовых credential-injection proxy созрел (iron-proxy, Infisical Agent Vault — default-deny egress, подстановка секретов вместо placeholder-токенов, structured audit из коробки), поэтому **свой код для broker не нужен** и аргумент «системный язык ради broker» отпадает. Ядро — I/O-bound оркестратор (очереди, Telegram API, LLM API); безопасность Aegis — топология границ ОС (ADR-0001), язык ядра границей не является.

По sandbox индустриальный консенсус 2026 (в т.ч. SandboxEscapeBench, Oxford/UK AISI): голый Docker с shared kernel недостаточен для произвольного враждебного кода; стандарт — microVM (Firecracker/Kata) или gVisor. Но Firecracker требует Linux/KVM (недоступен на macOS и части VPS), а в MVP Aegis в sandbox исполняется не произвольный код из интернета, а git-pinned навыки, прошедшие review/verifiable loop (ADR-0003); враждебный **вход** идёт в Quarantine (ADR-0005), не в sandbox.

## Решение

**Язык ядра — TypeScript на Node.js LTS (strict mode).**

- Зависимости ядра — минимальный аудируемый набор: `better-sqlite3` (WAL, FTS5, `UPDATE…RETURNING`), Telegram-библиотека (выбор в Sprint 2), `zod` (валидация конфига/манифестов). Без LangChain/тяжёлых SDK.
- Supply-chain-митигации: lockfile в репозитории, `npm ci --ignore-scripts`, автоматический аудит зависимостей в CI, минимум транзитивных зависимостей как критерий выбора библиотек.
- Broker и sandbox — готовые компоненты, не наш код (подтверждает принцип «свой код — только ядро»).

**Рантайм sandbox MVP — Docker с обязательным hardened-профилем** (контракт, проверяется тестом V3):

- сеть: только user-defined `--internal` network, единственный доступный хост — broker-proxy; deny-all наружу на уровне отсутствия маршрута;
- `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root UID, `--read-only` rootfs + tmpfs `/tmp` (`noexec,nosuid`);
- явные mounts, read-only по умолчанию; лимиты memory/cpu/pids;
- образ пиннится по digest.

Ядро говорит с sandbox через узкий интерфейс `SandboxRunner` (одна реализация в MVP), чтобы замена рантайма не трогала оркестратор.

**Upgrade-path (зафиксирован):** gVisor (`runsc` — drop-in runtime для Docker на Linux) как первый шаг усиления; Kata/micro-VM — при выносе на выделенный Linux-хост. На macOS Docker исполняет контейнеры внутри VM (Hypervisor.framework) — граница фактически усилена на dev-машине.

## Последствия

**Плюсы:** максимальная скорость итераций малой командой; читаемое ядро в пределах ~4K LOC; один язык на весь свой код; экосистема покрывает все потребности (SQLite/FTS5, Telegram, fetch).

**Минусы и митигации:**

- Не single-binary деплой → docker-compose/systemd-unit в `deploy/` (Sprint 1).
- npm supply-chain риск → меры выше; список зависимостей ядра — ревьюится как код.
- `better-sqlite3` — нативный модуль → pin Node LTS; встроенный `node:sqlite` отмечен как кандидат на замену по мере созревания.
- Shared kernel у Docker — **признанное ограничение** (SECURITY_MODEL, «Границы модели»): для MVP приемлемо, потому что код в sandbox проходит verifiable loop и git-pinning, а не приходит с враждебного входа; при появлении сценариев исполнения менее доверенного кода upgrade-path обязателен к применению.

**Условия пересмотра языка:** появление собственного системного кода (свой broker/прокси, парсинг враждебных бинарных форматов в ядре) или выход ядра за I/O-bound профиль → новый ADR (кандидаты Go/Rust).

## Альтернативы

- **Go** — single binary, простота; отвергнут: медленнее итерации при равной memory-safety для I/O-кода, слабее инструментальная поддержка; выигрыш не оправдывает смену профиля команды.
- **Rust** — гарантии корректности; отвергнут: цена разработки для I/O-оркестратора не окупается — ядро не держит границу безопасности.
- **Firecracker/Kata с первого дня** — отвергнуто для MVP: нет KVM на macOS/части VPS; повышает порог self-hosted развёртывания; принято как upgrade-path.
- **Собственный broker на Rust/Go** — отвергнут: класс готовых компонентов существует; свой код увеличил бы доверенную поверхность.
