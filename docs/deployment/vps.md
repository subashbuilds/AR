# Deploying on a VPS (no Docker)

The same contract as `docker.md`, run directly: one Node process, one Python
worker, one data directory.

## Prerequisites

* Node >= 22.5 (`node:sqlite`) — the API's own `engines` floor
* Python 3.10 with `pip install -r requirements.txt` (opencv-python-headless,
  so no GL system libraries are needed)
* A domain with TLS if AR on phones is the point — WebXR requires a secure
  context; see the HTTPS section in `docker.md` for the Caddy snippet

## Install and build

```sh
git clone https://github.com/subashbuilds/AR.git objectcapture-ar
cd objectcapture-ar
pip install -r requirements.txt
(cd apps/web && npm install && npx vite build)
# sanity: imports resolve and the worker's CLI is callable
python3 -c "import cv2, numpy, scipy, PIL; print('cv2', cv2.__version__)"
python3 services/reconstruction-worker/run_job.py --help | head -2
```

The clone target dir name (`objectcapture-ar` above) is the host's choice; inside it
the repo is now laid out at the top level (no `objectcapture-ar/` subfolder) —
`apps/`, `services/`, `tests/`, `notebooks/`, `docs/` are all siblings of this
`README.md`.

## Run it

```sh
DATA_DIR=/var/lib/objectcapture-ar PORT=8787 node apps/api/src/server.js
```

`apps/api/src/config.js` resolves every path from the repo layout, so run from
the repository root; `DATA_DIR` is the only path you normally redirect.

## Keep it running (systemd)

```ini
# /etc/systemd/system/objectcapture-ar.service
[Unit]
Description=ObjectCapture AR (API + web + reconstruction worker)
After=network.target

[Service]
WorkingDirectory=/srv/objectcapture-ar   # the clone dir on the host; the repo is now rooted at that dir
Environment=DATA_DIR=/var/lib/objectcapture-ar
Environment=PORT=8787
ExecStart=/usr/bin/node apps/api/src/server.js
Restart=on-failure
User=objectcapture
# the worker is killed by the API after JOB_TIMEOUT_SECONDS (900s default)
Nice=10

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now objectcapture-ar`, then put TLS in front as in
`docker.md`. Health endpoint for monitoring: `GET /api/health` (reports
worker availability, limits and active jobs).

## Verify the deployment, not just the process

```sh
sh scripts/verify.sh pipeline   # reconstruction engine
sh scripts/verify.sh api        # capture API against the real worker
sh scripts/verify.sh web        # built app in a real browser
```

The three sections share no state; a machine that passes `pipeline` and `api`
but fails `web` has a web-build problem, not a reconstruction problem.

## Honest limitations

Same list as `docker.md`: single concurrent job, accounts stored in
`DATA_DIR` (first-party, local — back that up with the models), captures
private until their owner creates a revocable share link, per-IP upload budget
(5 captures / 10 min by default) and a separate sign-in budget (10 attempts /
5 min). Storage is your choice: the default keeps everything in `DATA_DIR`,
and `B2_KEY_ID`/`B2_APPLICATION_KEY`/`B2_BUCKET_NAME` make a Backblaze B2
bucket the durable copy, with the model served from it when the local file is
gone (docs/storage/README.md — the bucket must be private; see docs/status.md
§5 for what is still missing there). With B2 configured the photographs upload
straight to the bucket through presigned URLs rather than through the API's
body limit, so the bucket needs **CORS rules for this site's origin**
(`DIRECT_UPLOADS=0` turns the feature off). A finished capture's photographs are
pruned from the disk once the bucket holds them (`KEEP_LOCAL_COPIES=1` keeps
them), the retention sweep reaps abandoned uploads always and expired captures
only when `CAPTURE_TTL_DAYS` is above its default of `0` (which keeps them), and
`/account` lets an owner delete their account, its captures and its objects in
one password-confirmed step. **Terminate TLS in front**: the session cookie is marked
`Secure` only when the request arrives over HTTPS or `x-forwarded-proto:
https`, so a plain-HTTP deployment hands the session to anyone on the network.
There is no email verification and no password reset.
