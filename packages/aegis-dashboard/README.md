# Read-only AEGIS dashboard (F11)

Отдельный процесс наблюдаемости. **Не управляет** агентом — только читает SQLite в `readonly` режиме.

## Запуск

```bash
# из корня репозитория (нужен aegis.config.json и data/*.db)
npm run dashboard
```

Переменные окружения:

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `AEGIS_CONFIG` | `./aegis.config.json` | Путь к конфигу (data_dir, skills_dir, budget) |
| `AEGIS_DASHBOARD_HOST` | `127.0.0.1` | Bind address |
| `AEGIS_DASHBOARD_PORT` | `8787` | HTTP port |

Откройте `http://127.0.0.1:8787/` в браузере. Доступ извне — через SSH-туннель.

## Безопасность

- SQLite открывается с `{ readonly: true }` — физически нет права записи
- Нет POST/PUT/DELETE; единственный route — `GET /`
- Недоверенный контент (карантин) экранируется в HTML
- Подтверждения действий — только подсказка `/approve <token>` в paired-канале

## Тесты

```bash
npm run dashboard:test
```
