# 0006 — Backblaze B2, over its native API, behind a driver

Status: **accepted** (7 October 2026)

## Context

`docs/status.md` §5 recorded cloud object storage as the last unbuilt item on the
product's own critical path: photographs and models were files on the API host's
disk, with no storage boundary, no copy anywhere else, and no way to serve a
model whose host disk was gone. The product's own sharing flow makes that
visible — a QR code hands a second phone a URL to a model that exists in exactly
one place.

The choice of *provider* was made by the product owner: **Backblaze B2**, not
Cloudflare R2. The choice of *API* and *shape* was mine, and is what this record
is about.

Constraints that shaped it:

- the API has zero npm dependencies and is proud of it (`node:http`,
  `node:sqlite`, `node:child_process`);
- the reconstruction worker is a Python child process that needs a real
  filesystem for its inputs and outputs, so some local state is unavoidable;
- a capture must never be reported as finished when its model is not durable.

## Decision

**One `Storage` interface, two drivers** (`apps/api/src/storage.js`):
`LocalStorage` (the default, unchanged behaviour) and `B2Storage`. Selection is
`STORAGE_DRIVER=auto|local|b2`, and `auto` means B2 when its three settings are
present. Half a configuration falls back to local disk **and warns by name**
rather than letting a bucket stay quietly empty.

**The native B2 API v4, not the S3-compatible one.** `b2_authorize_account`,
`b2_get_upload_url`, `b2_upload_file`, `b2_download_file_by_name`,
`b2_list_file_names`, `b2_delete_file_version`, `b2_list_buckets`. This is
`fetch` + `node:crypto` only, so the zero-dependency property survives; S3 would
mean implementing SigV4 correctly for no capability this product needs.
Documented details are implemented literally: the percent-encoded
`X-Bz-File-Name`, the `X-Bz-Content-Sha1` B2 verifies, `Basic
base64(keyId:applicationKey)` on authorisation, the bucket id taken from the
key's own restriction when it has one.

**Publish before complete.** Photographs are stored as they are uploaded, and the
worker's `result.json` and `model.glb` are stored before the capture becomes
`completed`. If a photograph cannot be stored the capture is refused (`502`, and
the working directory is removed); if the model cannot be stored after a
successful reconstruction the capture ends `failed` with stage `storage`.
Saying "completed" would promise a model that may not exist.

**The working copy stays, and is pruned on purpose.** The worker needs real
files, so the local capture directory remains — the read path prefers it and
falls back to the stored object. With a remote driver that directory is a
cache, not the source of truth: a finished run deletes its scratch directory
always and its raw photographs once the bucket holds them, while keeping
`model.glb`/`result.json` as a warm cache (`KEEP_LOCAL_COPIES=1` keeps the
photographs too). Nothing is aged out on a clock; that is a product decision
left open, not a mechanism.

**Verified without an account.** `apps/api/test/b2-stub.js` implements the other
side of Backblaze's documented protocol and records every request, so the gate
(`apps/api/test/storage.test.js`, 21 tests, in `verify.sh api`) asserts the wire
format and the lifecycle — including the 401-then-reauthorise path, a rejected
checksum surfacing B2's own error, and the model still being served after the
local copy is deleted.

## Consequences

- A capture's bytes can now outlive the host they were made on, and a
  share-token read works from the bucket — the second-phone flow no longer
  depends on one disk.
- **The gate stands in a stub for the provider.** It cannot prove anything about
  Backblaze's service, only that this code speaks its documented protocol
  correctly; running it against the real bucket needs credentials and is written
  down in `docs/storage/README.md`.
- Until the keys are configured the product behaves exactly as before, and
  `/api/health` says `storage.kind: "local"` with `durable: false`, so a
  deployment's real posture is one request away.
- Still not built, and named as such: presigned uploads (photographs still pass
  through the API body limit), a time-based lifecycle/expiry policy, an SSE-C
  decision, and any audit of who read what. Account deletion **is** built
  (`DELETE /api/auth/account` removes an account's objects with its rows).
- The provider choice is a configuration-shaped decision, not a code-shaped one:
  `B2Storage` is one driver behind an interface, and a second provider would be
  a second file rather than a rewrite.
