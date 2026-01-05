# Agents / Automation Notes

This repository is ready for automation via Cloudflare Workers and local/Docker tooling. Key entry points for agent-driven workflows:

- **Deployments** – Run `npm install && npm run deploy` (Wrangler) after updating secrets via `npx wrangler secret put CLOUDFLARE_TOKEN`. CI/CD agents should ensure Wrangler auth is configured (via API token or `wrangler login`).
- **Local testing** – Agents can invoke `npm run dev` (Miniflare) for inline testing or `npm start` / Docker for full Node parity. All entropy fetches are asynchronous; no additional orchestration required.
- **Observability** – Logs include `hash-provider`, `entropy-source`, and `entropy-source-error/http/validation` events. Agents ingesting Workers logs can filter on these tags for monitoring.
- **Extensibility** – Additional entropy feeds can be added in `src/entropy.js` (see `buildSourceFetchers`). Keep network-bound fetch additions asynchronous and update `spec.md` to document changes.
- **Python helpers** – `client/cfrand.py` uses a single fetch then XORs the server hash with `os.urandom(64)` per call. It reads `CFRAND_URL` from `.env`.

Automations should respect the 5s per-source timeout and avoid overloading Radar endpoints (current implementation queries only the supported AS top list, HTTP/DNS summaries, and key timeseries).
