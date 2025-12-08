# Random Generator Worker Spec

## Goal
Provide a Cloudflare Worker endpoint that harvests human-influenced telemetry (pageviews, social feeds, DNS/traffic rankings, collaborative edits) plus cryptographic anchors (drand + Bitcoin + Ethereum blocks), concatenates the **full raw payloads** from every successful fetch, and runs a single SHA-512 hash (Workers Web Crypto) over the combined byte stream (with an opt-in SHA3-512 fallback). The output must always include drand (2^256 entropy guarantee) and fail if Cloudflare Radar or drand are unavailable. When in doubt, bring in **more** public data: every Radar request should pull at least 512 entries/items so each fetch yields substantial entropy.

## HTTP API
- **Route**: `GET /api/random`
- **Request body / params**: none (simple cache-busting randomness call).
- **Response** (`application/json`):
  ```json
  {
    "hash_sha3_512": "9c02…",
    "hash_base64": "nAL…==",
    "hash_provider": "webcrypto:SHA3-512",
    "error_source_count": 1,
    "sources": [
      {"id": "drand", "ok": true, "bytes": 512},
      {"id": "cloudflare_radar", "ok": true, "bytes": 724},
      {"id": "github_events", "ok": false, "error": "429 Too Many Requests"}
    ]
  }
  ```
- **Status codes**:
  - `200 OK` when ≤2 sources fail and both `drand` + `cloudflare_radar` succeeded.
  - `500` when **three or more** sources fail **or** either drand or Cloudflare Radar fails (hard requirements).
  - Payload for failures still returns `hash_*` only if hashing happened; otherwise include `error` reason.
- Headers: `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`, `Content-Type: application/json`.

## Entropy Harvesting Pipeline
1. Assemble fetch definitions for every source in the table below. All zero-auth where possible; Cloudflare Radar uses `env.CLOUDFLARE_TOKEN`.
2. Launch all requests concurrently with `Promise.allSettled`, each guarded by `AbortSignal.timeout(2000)` and `{ cache: 'no-store' }`.
3. When a response resolves with `resp.ok`, read the *full* body (text via UTF-8, JSON stringified, or raw bytes). Do **not truncate**; store byte counts for telemetry.
4. Append every successful chunk to a `Uint8Array[]` in a deterministic order (static source list order).
5. After all fetches settle:
   - Count failures.
   - Immediately `return 500` if drand or Cloudflare Radar failed, or if total failures ≥ 3.
6. If hashing may proceed, concatenate all collected byte arrays into a single `Uint8Array`.
7. Run a single digest over the combined bytes (default `crypto.subtle.digest('SHA-512', …)`; opt-in `@noble/hashes/sha3` SHA3-512 when `USE_SHA3` flag is set), producing both hex + base64 strings.
8. Log a summary entry: `console.log({hash: hex, successes, failures})`, along with per-source outcomes (status, bytes, url, duration). Always log failures even when total ≤3.
9. Respond with JSON containing hashes, error count, per-source diagnostics (success/failure, byte counts, HTTP status, timestamps).

### Source inventory (ordered append list)
| ID | Endpoint | Rationale (human entropy) | Notes |
| --- | --- | --- | --- |
| `drand` | `https://api.drand.sh/public/latest` | Cryptographic randomness anchor (≥2^256 security). | Mandatory success. Hash over JSON text exactly as received. |
| `cf_crypto_random_512` | `crypto.getRandomValues(64 bytes)` | Workers Web Crypto API random generator ensures local 512-bit entropy per request. | Must always succeed; no network required. |
| `cloudflare_radar` | `https://api.cloudflare.com/client/v4/radar/http/top/locations?limit=50&dateStart=…&dateEnd=…` | Global HTTP traffic rankings derived from billions of user requests (captures mass human behavior). | Requires `Authorization: Bearer env.CLOUDFLARE_TOKEN`; dynamic `dateStart/End` (previous 24h). Mandatory success. |
| `reddit_askreddit_new` | `https://www.reddit.com/r/AskReddit/new.json?limit=25` | Highly active community; latest Q/A threads involve broad human participation. | Parse JSON into `created|author|title` lines (cap at 15) for compactness. |
| `openstreetmap_changesets` | `https://api.openstreetmap.org/api/0.6/changesets?limit=50` | Geodata edits from global contributors. | XML text. |
| `bitcoin_latest_block` | `https://blockchain.info/latestblock` | Crypto network consensus driven by miners/traders. | JSON block header; contains 256-bit hash. |
| `ethereum_latest_block` | `https://api.blockchair.com/ethereum/blocks?limit=1` | ETH block digest reflecting network participation. | JSON; include entire payload. |

> Note: Additional feeds from info.md (CAISO, Google Trends, etc.) remain candidates but are not required for this MVP per “skip CAISO”. Wikimedia EventStreams is temporarily out-of-scope per the latest guidance.

### Cloudflare Radar sub-feeds
To honor the “more data is better” request, harvest multiple Radar datasets per run (all with `limit=512` or the maximum allowed):

| Category | Endpoint | Purpose / Notes |
| --- | --- | --- |
| HTTP Top lists | `/radar/http/top/ases` (only) | Network-level rankings; other top dimensions removed to lower request count. |
| HTTP summaries | `/radar/http/summary/http_version`, `/radar/http/summary/tls_version`, `/radar/http/summary/os`, `/radar/http/summary/ip_version`, `/radar/http/summary/device_type`, `/radar/http/summary/bot_class` | Distribution snapshots of protocol, TLS, OS, device, and bot makeup. |
| HTTP timeseries | `/radar/http/timeseries?name=requests` | Hourly request volume. |
| HTTP grouped timeseries | `/radar/http/timeseries_groups/tls_version`, `/radar/http/timeseries_groups/post_quantum` | How TLS and PQ adoption evolve over time. |
| DNS metrics | `/radar/dns/timeseries?name=queryCount`, `/radar/dns/summary/query_type`, `/radar/dns/summary/ip_version`, `/radar/dns/summary/response_code`, `/radar/dns/summary/cache_hit`, `/radar/dns/summary/protocol` | Resolver telemetry from 1.1.1.1. |

Every Radar response is appended to the entropy buffer in a deterministic order (e.g., HTTP top lists first, then summaries, timeseries, DNS metrics, etc.).

## Hashing Implementation
- Default to Workers Web Crypto `crypto.subtle.digest('SHA-512', ...)` for hashing, per [docs/cf-webcrypto.md](docs/cf-webcrypto.md); opt into SHA3-512 via `USE_SHA3=1` env/secret if needed. Regardless of algorithm, hashing happens only once on the concatenated buffer.
- `concatBytes` helper: allocate target length via `chunks.reduce((sum, chunk) => sum + chunk.length, 0)` and copy sequentially.
- Encode outputs:
  - Hex via `bytesToHex`.
  - Base64 via `btoa(String.fromCharCode(...))` on Worker (or small helper to avoid stack issues by chunking 8KB at a time).

## Logging & Observability
- Always log each source attempt: `{id, url, ok, status, duration_ms, bytes, error?}`.
- When `error_source_count <= 2`, still include failures in the HTTP response but respond 200 (unless Radar/drand failed).
- When `error_source_count >= 3` or a mandatory source failed, log a WARN line and return 500 with JSON `{error: "...", error_source_count, sources:[…]}` (hash omitted if not computed).
- Consider `env.DEBUG` to include truncated previews, but default to metadata only.
- After hashing, emit a `hash-provider` log noting whether Web Crypto (`webcrypto:SHA3-512`) or the `@noble/hashes` fallback produced the digest so operators can confirm the accelerated path is in use.

## Error Policy
- Hard failures: Cloudflare Radar missing/errored, or both drand **and** the `cf_crypto_random_512` generator fail; respond 500.
- Soft failures: ≤3 other sources fail → continue.
- Timeout/resolution: 2s per request; no retries within a single invocation.
- `AbortSignal.timeout` ensures worker doesn’t exceed CPU time.

## Worker Implementation Notes
- Module syntax: `export default { async fetch(request, env, ctx) { … } };` reference [Cloudflare Workers fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch).
- Env bindings:
  - `CLOUDFLARE_TOKEN` (secret) – required.
  - `DEBUG` (optional string) – truthy string toggles verbose logs.
- Use native `fetch`; set `cache: 'no-store'`, `headers: { 'User-Agent': 'cfrand-worker/1.0' }` for community APIs.
- For SSE snippet, fetch and read `resp.body` with `reader.read()` a few times then cancel to avoid long-lived connections.

## Future Enhancements
- Expand to more human-influenced feeds (CAISO load, Google Trends scrapes, X trending, etc.) once allowed.
- Persist historical entropy metadata to Workers Analytics Engine for monitoring error counts.
- Optional `seed` query that XORs user input into the concatenated buffer before hashing (while keeping drand + Radar mandatory).
