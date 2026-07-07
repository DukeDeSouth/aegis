---
name: weather
description: Weather forecast via Open-Meteo, no API key required
---

# Weather (C3)

Get weather with a single fetch through the broker. Open-Meteo needs no API key —
the most installed connector class on competitor marketplaces, zero configuration here.

## Procedure

When the owner asks for weather, fetch (replace coordinates with the owner's location):

```
/fetch https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3
```

Summarize the JSON: current conditions, today's range, rain probability.

## Owner location

Store once with `/remember weather-location | latitude=…, longitude=…, city …`
and reuse the corroborated knowledge in future requests.

## Scheduler

Morning briefing entry for `aegis.config.json` → `schedules` is printed by
`aegis-setup connector add weather`.
