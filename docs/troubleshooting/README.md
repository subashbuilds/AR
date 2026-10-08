# Troubleshooting

Failure modes the product actually has, with the message it actually shows
and what to do. Every behaviour named here is gated — the test column says
which. General reproduction of every claim: `docs/status.md` §7.

## Accounts

| Symptom | Cause | Fix |
|---|---|---|
| `/capture` sends you to the sign-in page | no session — a capture belongs to an account | sign in, or create one; the page remembers where you were going (`returnTo`) |
| "email or password is incorrect" | the pair did not match | check both; the message deliberately does not say which half was wrong, and an unknown address looks the same as a wrong password |
| "an account with that email already exists" | that address is registered | sign in instead |
| "password must be at least 10 characters" | the form's minimum, enforced by the server | use a longer passphrase |
| "Too many sign-in attempts from this client" (`429`) | the sign-in budget: 10 per client per 300 s | wait for the hinted retry time; raise `AUTH_BURST`/`AUTH_REFILL_SECONDS` only deliberately |
| Signed out unexpectedly | the 30-day session expired, or it was revoked by signing out on another device | sign in again (`node --test apps/api/test/auth.test.js`) |
| Deleted the wrong account / want the data back | `DELETE /api/auth/account` is irreversible: the account, its captures and their stored objects are removed in one step | nothing to undo — there is no export or soft-delete yet (`docs/security/README.md`); the app asks for the password precisely to make this deliberate |
| `401` "password is incorrect" on delete | the confirmation password did not match the session's account | enter the account's own password; the check is also rate-limited like a sign-in |

## Sharing and access

| Symptom | Cause | Fix |
|---|---|---|
| "This model is not public" (`401`) | you opened a model link with no session and no share token | sign in as the owner, or use the link the owner shared |
| "This model is not shared" / "this share link is no longer active" (`403`) | the owner never created a link, or stopped sharing | ask the owner for a new link — a revoked one is dead permanently, not suspended |
| "this capture belongs to another account" (`403`) | the capture is someone else's | nothing to fix; you cannot read, cancel or share it |
| "this capture predates accounts and has no owner" (`403`) | the row was created before accounts existed (`user_id = NULL`) | it is readable by nobody, by design; re-run the capture |
| The QR code opens nothing on a second phone | the link was revoked, or the phone has an old code | tap **Create a share link** again — a new token is minted, never the old one |
| A shared model looks like it is missing on the second phone | the page was opened without its `?t=` token | use the full link (or QR), or sign in as the owner (`node --test apps/web/test/share.test.ts`) |

## Storage

| Symptom | Cause | Fix |
|---|---|---|
| `GET /api/health` shows `storage.kind: "local"` with `durable: false` | no B2 credentials, so captures are on this host's disk only | add `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` (`docs/storage/README.md`) |
| `502` "image N could not be stored in the object store" | the bucket rejected the upload and the capture was refused rather than accepted and lost | read the B2 code in the message (`unauthorized` → the key or its capabilities; `storage_cap_exceeded` → the account cap); nothing was left in the bucket or on disk |
| `failed`, stage `storage`, "the reconstruction could not be stored" | the reconstruction succeeded but the model could not be put in the bucket | fix the bucket/key, then re-run the capture — a `completed` capture would have promised a model that may not exist (`apps/api/test/storage.test.js`) |
| `health.storage.warnings` names missing keys | `B2_KEY_ID`/`B2_APPLICATION_KEY`/`B2_BUCKET_NAME` is **half** configured (or `STORAGE_DRIVER=b2` was asked for with nothing set) | set all three, or unset `STORAGE_DRIVER` and accept local disk; the code will not silently pretend a bucket is in use |
| "B2 account has no bucket named …" in the logs | `B2_BUCKET_NAME` does not match a bucket the key may see | check the bucket name, and that the key is restricted to it (or has `listBuckets`) |
| The model 409s with "no longer stored" | `completed` but neither the local copy nor the bucket has the object | this is the honest failure for a lost artifact; check the bucket for `captures/<id>/model.glb` and the host's `DATA_DIR` |
| `409` `direct_uploads_unavailable` | the driver cannot presign (local disk), or `DIRECT_UPLOADS=0` | not a fault: the browser falls back to the request-body route and the capture still works (`apps/api/test/direct-upload.test.js`) |
| Direct uploads fail and every capture takes the slow route | the bucket has no CORS rules for the app's origin, so the browser blocks the upload; or WebCrypto is unavailable | add CORS rules allowing `POST` from the app origin with the headers the API hands out (`docs/storage/README.md`); the client deliberately falls back rather than failing the capture |
| A capture appears to vanish after a direct upload | it never called `/uploads/complete`, so the row stayed `uploading` (excluded from `GET /api/captures`) and was reaped | retry the capture; an abandoned `uploading` row is swept after `UPLOAD_ABANDONED_MINUTES` (120 min) by design |
| `400` "the object … is not a JPEG, PNG or WebP" on `…/uploads/complete` | the declared media type did not match the bytes that landed in the bucket | the capture is removed whole rather than queued with bad input; fix the client's declared type (`apps/api/test/direct-upload.test.js`) |

## Capture / upload

| Symptom | Cause | Fix |
|---|---|---|
| "Continue" stays disabled | fewer than the minimum photos (12) | take more shots around the circle |
| `401` "sign in to start a capture" | no session | sign in; the capture screen is behind `RequireAuth` (`/auth?returnTo=/capture`) |
| `429` with a retry message | upload rate limit: burst 5, +1 per 600 s per client | wait for the hinted retry time, or raise `UPLOAD_BURST`/`UPLOAD_REFILL_SECONDS` |
| `413` "image is N bytes, limit is M" | photo over `MAX_IMAGE_BYTES` (12 MiB) | resize/re-export the photo; raise the limit only deliberately |
| `400` "image bytes are not a JPEG, PNG or WebP" | payload mislabelled or not an image | re-export as JPEG/PNG/WebP — the container bytes are sniffed on purpose |
| `503` worker not available | `run_job.py` missing or Python not found | check `GET /api/health` → `worker.entrypoint`, `worker.python`; install `requirements.txt` (`docs/deployment/vps.md`) |

## Reconstruction

| Symptom | Cause | Fix |
|---|---|---|
| `failed` at stage `feature` | too little overlap or texture between photos | reshoot with 15–30° steps and more texture in frame |
| `failed` at stage `sfm` | no view pair could be verified, or too few views registered | more photos, more overlap; single-pair recovery is known-unreliable by design (`benchmark_sift.py` FAILs on one pair) |
| `failed` with stage `timeout` | job exceeded `JOB_TIMEOUT_SECONDS` (900 s) | fewer/shooter photos; raise the limit if the machine can take it (`apps/api/test/timeout.test.js`) |
| `failed` with the worker's own message | that message *is* the diagnosis — the API never rewrites it | act on the named stage; nothing is retried into success (ADR 0004) |
| Capture stuck `running` | it is not — progress comes from worker logs, and the job dies at the time limit | press **Cancel reconstruction**; it ends `cancelled`, never `failed` (`apps/api/test/cancel.test.js`) |
| Capture stuck `queued` (or `running`) across a restart | the job queue is in memory, so a restart forgets what it held | not a fault: boot re-queues unfinished captures and runs them again from the start (`apps/api/test/worker.test.js`). If one is still stuck, the worker cannot start — check `GET /api/health` → `worker.available` and `docs/deployment/vps.md` |
| Only 8/12 (or 10/24) views used | the measured registration limit; the holdouts lack pose consensus | nothing to flip — see `docs/status.md` §3f and ADR 0003; the model page reports exactly which photos were unused and why (§3e) |
| An old capture disappeared from the list | `CAPTURE_TTL_DAYS` is set above `0` and the capture aged out | set it to `0` (the default) to keep captures until their owner deletes them; the sweep logs what it removed (`apps/api/test/retention.test.js`) |

## Model page

| Symptom | Cause | Fix |
|---|---|---|
| "PARTIAL orbit — largest gap N°" | photos never circled the object | reshoot the missing arc; width/depth can read too small because the unphotographed side is not in the model (§3) |
| "uncalibrated" units | no measurement was supplied at capture time | the number is honest; a real measurement is the only fix (the pipeline will not invent metres) |
| Coverage feels low / surface patchy | sparse cloud covers ~78.6% of its own points on the true surface; dense MVS is deliberately off because it invents geometry (ADR 0001) | more views with good overlap; this is the binding limit, documented not hidden |
| Photos listed as "not used" | per-photo review found them weak or unplaceable | read the stated reason; reshoot those angles with more overlap (§3e) |
| GLB download 409 | capture not `completed`, or you raced the export | wait for `completed`; a cancelled/failed capture never serves a model — by design |

## AR / sharing

| Symptom | Cause | Fix |
|---|---|---|
| "AR is not available on this device" | no WebXR immersive-AR (e.g. desktop browser) | the page states which capability is missing — on a real phone the hit-test path is **hardware-unverified** (§4), so treat placement as untested until run on-device |
| QR link opens nothing | server origin differs from the one you scanned | the QR encodes the share URL the server reported; open it from the same host or rebuild the share sheet |
| Model appears wrong-scale in AR | calibration missing or the capture was partial | set a real measurement at capture; complete the orbit (§3) |

## Running the checks yourself

```sh
sh scripts/verify.sh            # everything (sections runnable individually)
sh scripts/verify.sh api        # API + real worker, incl. accounts, cancel & timeout
sh scripts/verify.sh web        # typecheck, build, unit tests, 22 e2e steps
python3 -m pytest tests/test_pipeline.py -q
```

If a check fails, its output names the failing behaviour — fix that, not the
check. Deliberate-failure gates (`benchmark_sift.py`, `eval_densify.py`) are
documented as such in `scripts/verify.sh`.
