# Architecture Decision Records

Короткие записи ключевых архитектурных решений: контекст, решение, последствия. Формат — по Майклу Найгарду.

| #                                                 | Решение                                           | Статус   |
| ------------------------------------------------- | ------------------------------------------------- | -------- |
| [0001](0001-four-trust-domains.md)                | Четыре trust-домена вместо монолита               | Accepted |
| [0002](0002-verifiable-memory.md)                 | Память с эпистемическими статусами                | Accepted |
| [0003](0003-declarative-skills-first.md)          | Навыки как данные по умолчанию                    | Accepted |
| [0004](0004-credential-broker.md)                 | Секреты через broker, не в процессе агента        | Accepted |
| [0005](0005-quarantine-untrusted-input.md)        | Карантин недоверенного входа                      | Accepted |
| [0006](0006-core-language-and-sandbox-runtime.md) | Язык ядра — TypeScript; sandbox — hardened Docker | Accepted |
| [0007](0007-skill-manifest-format.md)             | Формат capability-манифеста навыка                | Accepted |
| [0008](0008-llm-provider-abstraction.md)          | LLM: OpenAI-совместимый протокол, тонкий клиент   | Accepted |
| [0009](0009-post-mvp-core-loc-budget.md)          | Post-MVP LOC порог 5000 (Sprint 11–12)            | Accepted |
| [0010](0010-oauth-refresh-sidecar.md)             | OAuth-refresh sidecar в trust-домене broker       | Accepted |

Новые ADR нумеруются по порядку. Решение не удаляется, а помечается `Superseded by NNNN`.
