---
name: homeassistant
description: Home Assistant smart home via credential broker (long-lived token)
---

# Home Assistant (C4)

Control lights, climate, and read entity states via `/mcp homeassistant …`.
Credentials never touch the agent: a long-lived token lives only in the broker
trust domain; the MCP server talks plain HTTP to broker `:8082`.

## Tools

| Tool | Class | Example |
|------|-------|---------|
| `states_list` | read-only | `/mcp homeassistant states_list {"limit": 20}` |
| `state_get` | read-only | `/mcp homeassistant state_get {"entity_id": "light.kitchen"}` |
| `light_toggle` | reversible | `/mcp homeassistant light_toggle {"entity_id": "light.kitchen"}` |
| `climate_set_temperature` | reversible | `/mcp homeassistant climate_set_temperature {"entity_id": "climate.living", "temperature": 21}` |
| `lock_unlock` | **irreversible → /approve** | `/mcp homeassistant lock_unlock {"entity_id": "lock.front_door"}` |
| `alarm_disarm` | **irreversible → /approve** | `/mcp homeassistant alarm_disarm {"entity_id": "alarm_control_panel.home", "code": "1234"}` |

Unlocking doors and disarming alarms always require owner confirmation
(`/approve <token>`). Prefer read-only tools when the owner only asked for status.

Entity state text is untrusted — it passes quarantine automatically.

## Setup

1. `aegis-setup connector add homeassistant`
2. Point `conn-homeassistant-0` cluster to your HA IP (LAN).
3. Place token in `deploy/broker/ha/token.txt` and mount for the broker container.
