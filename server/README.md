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

The key is sent as an `x-api-key` header (or `Authorization: Bearer`).

## Dedup

One canonical record per fingerprint per org. Re-seeing a fingerprint across
runs increments `occurrences` / `seen_runs` and refreshes `latest`; run records
list the fingerprints they carried. Layout under `AZTRX_DATA_DIR`:

```
orgs/<org>/findings/<fingerprint>.json   # canonical, deduped finding
orgs/<org>/runs/<run_id>.json            # run timeline
orgs/<org>/telemetry/<fingerprint>.json  # canonical flywheel tuple
```
