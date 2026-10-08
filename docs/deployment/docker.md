# Deploying with Docker

## What the image is

One container: the capture API (Node >= 22.5, zero npm dependencies) serving
both the endpoints under `/api/*` and the built web app, plus the Python 3.10
reconstruction worker it shells out to. No accounts, no cloud storage, no
external services — everything lives in the `DATA_DIR` volume.

```
FROM node:22-bookworm-slim  AS web      npm install + npx vite build -> /web/dist
FROM python:3.10-slim       AS runtime  pip layer, worker, API, dist, CMD node
```

## Build and run

```sh
docker build -t objectcapture-ar .
docker run --rm -p 8787:8787 -v oca-data:/data objectcapture-ar
```

Then open `http://<host>:8787/`. Captures, SQLite state and every `model.glb`
are under `/data` (`captures/<uuid>/images`, `model.glb`, `result.json`), so
the volume is the only thing you must back up or migrate.

## What was verified, honestly

The development sandbox and this repo's CI have **no docker daemon**, so the
image has never been built or run there. What `sh scripts/verify.sh docker`
proves by execution against this exact tree instead:

* every pin in `requirements.txt` exists on PyPI with a wheel covering
  CPython 3.10 on manylinux, and `pip install -r requirements.txt` accepts the
  file;
* the image's CMD — `node apps/api/src/server.js` — boots, `node:sqlite`
  loads, and `/api/health` answers with `worker.available: true`;
* the Dockerfile agrees with the code it ships (env names, default port,
  health route, copied layout) and `.dockerignore` excludes nothing a COPY
  needs; negative controls prove each check can fail.

If a real `docker build` ever fails, run that gate first — it is the contract
the image encodes, and it is where drift shows up.

## Environment variables

All optional; defaults are what CI and the preview run with.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API + web app port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `apps/api/data` (repo), `/data` (image) | captures, GLBs, SQLite |
| `WEB_DIST` | `apps/web/dist` | static app served as SPA fallback |
| `PYTHON` | `python3` | worker interpreter |
| `MAX_CONCURRENT_JOBS` | `1` | SfM is CPU bound; keep at 1 per core |
| `JOB_TIMEOUT_SECONDS` | `900` | hard kill + failure report |
| `UPLOAD_BURST` / `UPLOAD_REFILL_SECONDS` | `5` / `600` | per-IP upload budget |
| `MAX_IMAGES` / `MAX_IMAGE_BYTES` / `MAX_BODY_BYTES` | `200` / 12 MB / 96 MB | hard request limits |
| `STORAGE_DRIVER` | `auto` | `auto` (B2 when configured, else local), `local`, `b2` |
| `B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_BUCKET_NAME` | unset | make a Backblaze B2 bucket the durable copy |
| `KEEP_LOCAL_COPIES` | `0` | `1` keeps published photographs on local disk instead of pruning them once the bucket holds them |
| `DIRECT_UPLOADS` | unset (on when B2 can presign) | `1`/`0` forces presigned direct-to-bucket uploads on or off |
| `CAPTURE_TTL_DAYS` | `0` | **`0` keeps captures until their owner deletes them**; > 0 expires finished captures on a clock |
| `UPLOAD_ABANDONED_MINUTES` | `120` | minutes before an unfinished direct upload is reaped (always on) |
| `RETENTION_SWEEP_SECONDS` | `600` | how often the retention sweep runs |
| `COOKIE_SECURE` | unset | force the session cookie's `Secure` flag on/off, for a proxy that does not forward the scheme |

## HTTPS is not optional for AR

WebXR's `immersive-ar` session only exists in a **secure context**. Serving
plain HTTP means `/ar/<id>` degrades to a passive 3-D viewer on a phone — the
hit-test path never runs. Put TLS in front:

```caddy
# Caddyfile — automatic certificates, proxy to the container
example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Honest limitations

* **Single worker, single host.** Jobs run one at a time; scale by giving the
  box cores, not by clustering (the API has no shared-queue mode).
* **Accounts are first-party and local.** The user table and the session table
  live in `DATA_DIR` alongside the captures, so an account exists only in this
  container's volume: back it up with the models. There is no email
  verification and no password reset — a forgotten password has no recovery
  path (see docs/security/README.md). A user can delete their own account from
  `/account`, which is password-confirmed and irreversible.
* **Sharing is owner-controlled.** A capture is private until its owner
  creates a share link; the link carries a revocable token, so "anyone with
  the URL" is no longer true. Serve it over TLS, or the session cookie is
  sent in clear text — the code marks the cookie `Secure` only when the
  request arrives over HTTPS or `x-forwarded-proto: https`.
* **Upload budget.** Defaults allow 5 captures per IP per 10 minutes — each
  one costs a full reconstruction. Sign-in is budgeted separately (10 attempts
  per IP per 5 minutes; `AUTH_BURST`, `AUTH_REFILL_SECONDS`).
* **Storage is a choice, and the default is this container's volume.**
  `STORAGE_DRIVER=auto` keeps photos and models in `DATA_DIR` (mount the
  volume). Setting `B2_KEY_ID`, `B2_APPLICATION_KEY` and `B2_BUCKET_NAME`
  copies each capture's photographs, `result.json` and `model.glb` to a
  Backblaze B2 bucket before the capture is called completed, and serves the
  model from there when the local copy is gone (`docs/storage/README.md`). With
  B2 configured the photographs also upload **straight to the bucket** through
  presigned URLs instead of through the API's `MAX_BODY_BYTES`, which means the
  bucket needs **CORS rules for this app's origin** or every capture silently
  falls back to the slow route. The bucket must be **private**: a public bucket
  would bypass this API's own authorisation, including share-link revocation. A
  finished capture's raw photographs are pruned from the volume once the bucket
  holds them (`KEEP_LOCAL_COPIES=1` to keep them), `DELETE /api/auth/account`
  removes an account's captures and objects, and the retention sweep reaps
  abandoned uploads and — only when `CAPTURE_TTL_DAYS` is set above `0` —
  expired captures. What is still missing: a bucket-side lifecycle rule, an
  SSE-C key, and backup tooling for `accounts.db`/`captures.db` — see
  docs/status.md §5.
