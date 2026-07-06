# Credential Broker

Готовый компонент (ADR-0004): **Envoy** с официальным HTTP-фильтром
`envoy.filters.http.credential_injector`. Собственный код здесь не живёт — только
конфигурация. Требуется Envoy **>= v1.36** (поле `header_value_prefix` у Generic
credential; на v1.35 конфиг не проходит `--mode validate`).

## Почему Envoy

- фильтр официальный и делает ровно паттерн брокера: подставляет секрет в
  заголовок исходящего запроса; агент/sandbox видят только placeholder-трафик;
- fail-closed из коробки: нет секрета или ошибка инжекции → `401`, неизвестный
  Host → `404` (маршрута нет);
- TLS origination на кластере: sandbox говорит с брокером plain HTTP в
  изолированной internal-сети, наружу брокер сам ходит по TLS — MITM-CA не нужен;
- один статический yaml, образ пиннится по digest.

Альтернативы (Vault agent без proxy-инжекции, свой прокси) отвергнуты в ADR-0004/0006.

## Файлы

| Файл          | Назначение                                                             |
| ------------- | ---------------------------------------------------------------------- |
| `envoy.yaml`  | Конфиг брокера: listener 8080, allowlist-маршруты, credential_injector |
| `secret.yaml` | SDS-обёртка: generic secret из файла `/etc/broker/token.txt`           |
| `token.txt`   | **Не в репозитории.** Сырой секрет; монтируется только брокеру         |

## Как задать секрет

1. Положите значение ключа (без перевода строки) в файл на хосте:
   `printf '%s' "$KEY" > /secure/place/token.txt && chmod 600 /secure/place/token.txt`
2. Укажите путь в `AEGIS_BROKER_SECRET_FILE` (см. `deploy/docker-compose.yml`).
   Файл монтируется read-only только в контейнер брокера — ядро и sandbox его
   не видят ни через env, ни через ФС (проверяется тестом V2).

## Как добавить хост в allowlist

Скопируйте пару `virtual_host` + `cluster` в `envoy.yaml` (домен, SNI, endpoint),
затем провалидируйте конфиг без запуска:

```sh
docker run --rm -v "$PWD:/etc/broker:ro" envoyproxy/envoy:v1.37.1 \
  envoy --mode validate -c /etc/broker/envoy.yaml
```

## Сетевые инварианты (V3)

- Сеть `aegis-internal` (`internal: true`) — deny-all egress по построению: у
  контейнеров в ней нет маршрута наружу. Broker подключён также к `aegis-egress`
  и является единственным шлюзом.
- **Не подключайте к `aegis-internal` ничего, кроме broker и sandbox**: Docker-DNS
  внутри сети резолвит всех её участников, изоляция держится на составе сети.
