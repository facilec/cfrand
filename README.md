# cfrand

A Cloudflare Worker API that mixes high-volume human-influenced telemetry (Cloudflare Radar HTTP/DNS insights, GitHub events, Reddit frontpage, OpenStreetMap changesets, latest Bitcoin/Ethereum blocks) with first-class randomness sources (Cloudflare Web Crypto RNG + drand beacon). Each call fetches fresh payloads, concatenates the raw bytes, and runs a single SHA3-512 hash to yield a base64/hex digest and per-source diagnostics.

## Features

- **Multiple entropy feeds:** Cloudflare Radar summaries/timeseries, GitHub public events, OpenStreetMap changesets, Reddit front page, Bitcoin/Ethereum latest blocks, plus drand.
- **Edge-native randomness:** Includes 512 bits from `crypto.getRandomValues` and enforces drand+Radar availability.
- **Single hash extraction:** Concatenates all successful payloads and computes SHA3-512 (via `@noble/hashes`).
- **Operational telemetry:** Response lists each source (success/failure, byte count, duration), hash provider, and error counts.

## Deploying to Cloudflare

Prerequisites: Node 20+, npm, Wrangler CLI (installed automatically via `devDependencies`).

```bash
npm install
npx wrangler login                   # once, opens browser
npx wrangler secret put CLOUDFLARE_TOKEN   # paste Radar API token (Account → Radar permission)
npm run deploy
```

You can then query the Worker:

```bash
curl -s https://<your-worker>.workers.dev/api/random | jq
```

## Local development

- **Workers dev server:** `npm run dev` (Wrangler/Miniflare) serves `/api/random` at <http://localhost:8787>.
- **Node/Docker clone:**
  - Local Node: `npm start` (uses `local/server.js`).
  - Docker: `docker build -t cfrand .` then `docker run -p 8787:8787 -e CLOUDFLARE_TOKEN=... cfrand`.

Both local modes share the same entropy pipeline, so you can test without deploying.

## Configuration

| Variable | Description |
| --- | --- |
| `CLOUDFLARE_TOKEN` | Radar API token (Workers secret for deploy, env var for Node/Docker). |
| `DEBUG` | Optional flag to enable extra logging (set via Wrangler vars or env). |
| `USE_SHA3` | Set to `1`/`true` to force SHA3-512 hashing (`@noble/hashes`). By default the Worker uses Web Crypto SHA-512. |

## Project structure

```
.
├── src/
│   ├── entropy.js      # Shared entropy pipeline
│   └── worker.js       # Cloudflare Worker entry point
├── local/server.js     # Node HTTP server for local/Docker usage
├── Dockerfile
├── wrangler.toml
├── README.md
├── AGENTS.md
└── ...
```

## API response shape

```json
{
  "hash_sha3_512": "0669...",
  "hash_base64": "Bm...=",
  "hash_provider": "@noble/hashes",
  "error_source_count": 0,
  "sources": [
    {"id": "cf_crypto_random_512", "ok": true, "bytes": 64, ...},
    {"id": "cloudflare_radar_http_summary_tls_version", "ok": true, ...},
    {"id": "github_events", "ok": true, ...},
    ...
  ]
}
```

HTTP status is 200 when ≤2 sources fail and both Radar plus at least one of (drand, cf_crypto) succeed; otherwise 500 with `error` field.
