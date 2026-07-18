---
name: shopping-list
description: Grocery list + price watch (C19 composition)
---

# Shopping list (C19)

Bought-list workflow using **workspace** + **/watch** (C8). No new core code.

## Layout

```
workspace/shopping/
  list.md           # items with optional product URLs
  order-draft.md    # agent draft for review
```

## Procedure

1. `/read workspace/shopping/list.md`
2. For each URL: `/watch <url>` on schedule (price drop)
3. `/write workspace/shopping/order-draft.md | …` — draft only, never auto-checkout

## Scheduler

See `connector.json` config_hints for Saturday review cron.
