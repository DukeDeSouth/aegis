# Travel proxy (C20)

HTTP sidecar on the broker host. Injects aviationstack `access_key` from a local file; sandbox only calls `travel.local` on listener `:8087`.

## Bootstrap

1. Copy `api-key.example.txt` → `api-key.txt` with your [aviationstack](https://aviationstack.com/) access key (`chmod 600`).
2. Add to `deploy/docker-compose.yml` (network `aegis-internal`):

```yaml
  travel-proxy:
    image: node:24-alpine
    restart: unless-stopped
    command: ['node', '/app/proxy.mjs']
    networks: [aegis-internal]
    environment:
      TRAVEL_API_KEY_FILE: /etc/broker/travel/api-key.txt
      TRAVEL_PROXY_PORT: '8787'
    volumes:
      - ./broker/travel/proxy.mjs:/app/proxy.mjs:ro
      - ./broker/travel/api-key.txt:/etc/broker/travel/api-key.txt:ro
```

3. `aegis-setup connector add travel` — adds listener `:8087` → `127.0.0.1:8787` with credential injector.
4. Restart broker (envoy) and `travel-proxy`.

## Flow

`sandbox fetch_flight.sh` → `http://aegis-broker:8087/v1/flights?flight_iata=SU123` (Host: `travel.local`) → Envoy adds `Authorization: <key>` → proxy forwards to `https://api.aviationstack.com/v1/flights?access_key=…`.
