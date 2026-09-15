# Aztrx cloud ingest

Dependency-free Node HTTP server for `api.aztrx.app`. Two ingest routes, org +
API-key validation, and a JSON-file dedup store keyed by crash fingerprint. No
npm dependencies — Node's built-in `http` only.

## Run

```bash
# dev
AZTRX_API_KEYS='{"sk_live_123":{"org":"acme","label":"Acme Inc"}}' npm run server

# or manage keys in a file (gitignored), copied from keys.example.json
cp server/keys.example.json server/keys.json
npm run server
```

## Configuration (env)

| var | default | purpose |
| --- | --- | --- |
| `AZTRX_PORT` | `8787` | listen port |
| `AZTRX_DATA_DIR` | `server/.data` | JSON-file store root (gitignored) |
| `AZTRX_API_KEYS` | _(unset)_ | JSON object `{ "<apiKey>": { "org", "label" } }`; falls back to `server/keys.json` |

With no keys configured the server is deny-all: only `/health` is reachable.

## Endpoints

| route | auth | purpose |
| --- | --- | --- |
| `GET /health` | none | uptime probe |
| `POST /api/runs` | `x-api-key` | ingest a completed run (findings + counts); dedups by fingerprint |
| `POST /api/telemetry` | `x-api-key` | ingest flywheel tuples; dedups by `crash_fingerprint` |
| `GET /api/org` | `x-api-key` | the deduped findings + run count for the key's org |
| `GET /api/runs` | `x-api-key` | the org's run timeline, newest first |
| `GET /api/findings/:fingerprint` | `x-api-key` | one canonical finding — `404` if the fingerprint was never seen |

The key is sent as an `x-api-key` header (or `Authorization: Bearer`).

These read routes exist for the hosted dashboard (`aztrx.app/dashboard` in
`web/`), which calls them straight from the browser; the server answers with
`Access-Control-Allow-Origin: *` for that reason.

## Dedup

One canonical record per fingerprint per org. Re-seeing a fingerprint across
runs increments `occurrences` / `seen_runs` and refreshes `latest`; run records
list the fingerprints they carried. Layout under `AZTRX_DATA_DIR`:

```
orgs/<org>/findings/<fingerprint>.json   # canonical, deduped finding
orgs/<org>/runs/<run_id>.json            # run timeline
orgs/<org>/telemetry/<fingerprint>.json  # canonical flywheel tuple
```

## Deploy

The repo root carries a Render blueprint (`render.yaml`) that runs this server
from `server/Dockerfile` with a persistent disk at `/data`. Render is the easy
path; any Docker host works the same way.

```bash
# local smoke test of the exact image the blueprint builds
docker build -f server/Dockerfile -t aztrx-ingest .
docker run -p 8787:8787 -v "$(pwd)/server/.data:/data" \
  -e AZTRX_API_KEYS='{"sk_live_123":{"org":"acme","label":"Acme Inc"}}' \
  aztrx-ingest
curl http://localhost:8787/health   # → {"ok":true,"orgs":1}
```

Steps for the hosted `api.aztrx.app`:

1. Render → New → **Blueprint**, point at `github.com/Aztrx-AI/aztrx`.
2. In the service's Environment, set `AZTRX_API_KEYS` to the operator registry
   (the same JSON shape as `keys.example.json`). Nothing else is required —
   `AZTRX_DATA_DIR` and the disk come from the blueprint.
3. DNS: CNAME `api.aztrx.app` → `aztrx-ingest.onrender.com`.
4. Confirm `curl https://api.aztrx.app/health` returns `{"ok":true,"orgs":N}`.

In the container, keys come **only** from `AZTRX_API_KEYS` — the compiled image
has no `keys.json` and the store's whole state is the mounted `/data` volume.
