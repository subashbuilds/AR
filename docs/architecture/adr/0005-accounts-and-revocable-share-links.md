# 0005 — First-party accounts, and a share link that is not the URL

Status: **accepted** (7 October 2026)

## Context

Until this decision, the capture API had no notion of a user. A capture was
addressed by an unguessable UUID and **that UUID was the credential**: anyone
holding the link could read the model, and nobody could take the link back
short of deleting the capture. Every capture that had ever been made was also
listed to every visitor of `GET /api/captures`.

`docs/status.md` §5 recorded this as the top unbuilt item and as *both* a
security problem and a product blocker: a product whose entire purpose is
handing a model to a second phone has no answer to "who may see this?" without
accounts, and no answer to "stop showing it to them" without revocation.

Two things had to be chosen: where identity comes from, and what authorises a
read.

## Decision

**Identity is first-party and local.** `apps/api/src/accounts.js` implements
email + password with `node:crypto` scrypt (N=16384, r=8, p=1, 64-byte key,
per-user salt), sessions as opaque 256-bit tokens stored only as SHA-256
digests with a 30-day expiry, and an `HttpOnly; SameSite=Lax` cookie
(`Secure` when the request arrived over TLS). No third-party identity provider,
no external call, no npm dependency — consistent with the rest of the API,
which is `node:http` + `node:sqlite` + `node:child_process`.

**A read is authorised by the owning session, or by a revocable share token
that is a different secret from the capture id.** `POST
/api/captures/:id/share` mints a 192-bit token, is idempotent (asking twice
returns the same live link, so a printed QR code keeps working), and is
owner-only; `DELETE …/share` deletes it. The token is compared against the row
on every request, so revocation takes effect on the next one — no cache, no
"immutable" GLB response, `private, max-age=60` instead.

**Refusals are specific, not opaque.** `401` when there is no session and no
token, `403` when a session is not the owner, `403` when a supplied token no
longer matches. A non-owner asking about a capture's *share link* gets the
same `404` as an unknown id, so the endpoint cannot be used to discover which
captures exist.

**Chosen alternatives that were rejected:**

- *A third-party identity provider (hosted auth).* Rejected for now, not
  forever: it would add an external dependency and a set of credentials to the
  single-process design, and it does not by itself answer the revocation half
  of the problem. It remains a reasonable swap behind the same routes, and
  `docs/security/README.md` lists what first-party auth deliberately does not
  have (email verification, password reset, MFA) — all of which are the
  strongest argument for it later.
- *Keep the UUID as the capability and add ownership only.* Rejected: it
  leaves the second-phone flow unrevocable, which is the actual product
  requirement, and it would make "private" and "shared" indistinguishable in
  the data model.
- *Share-on-by-default (mint a token at capture time).* Rejected: sharing is a
  decision the owner makes, and a token that exists before it is asked for is
  a second credential nobody chose. The UI offers **Create a share link**, and
  the page says plainly that a link holder can read the model until it is
  revoked.

## Consequences

- **Measured, not asserted.** `apps/api/test/auth.test.js` (11 tests) covers
  account creation, the scrypt-only storage, indistinguishable sign-in
  failures, session expiry and sign-out, cross-account refusal, share creation
  / idempotence / revocation, the owner-only cancel, the separate sign-in rate
  bucket, the `Secure` cookie behind TLS and the `COOKIE_SECURE` override;
  `apps/web/test/share.test.ts`
  pins the client contract that every read a shared page makes carries its
  token; and four e2e steps drive the real browser through the gated route,
  the private model, a cookie-less second device reading the shared model, and
  the revocation that stops it.
- **A capture created before this change has `user_id = NULL`** and is
  readable by nobody. `Store.migrate()` adds the columns to an existing
  database in place rather than discarding it, and the API says so rather than
  pretending the row is someone's.
- **The sign-in budget is separate from the upload budget** (10 attempts per
  client per 300 s, spent before the scrypt comparison), because guessing a
  password should not be able to consume, or be limited by, the expensive
  capture endpoint's allowance.
- **What is still missing is written down**: no email verification, no
  password reset, no MFA, no data export, no audit log
  (`docs/security/README.md`). Account deletion and cloud storage were added
  afterwards — `DELETE /api/auth/account` is password-confirmed and erases the
  account's captures, objects and sessions (ADR 0006 covers the storage
  boundary). A reader of this repository should be able to tell what protects a
  capture from what merely looks like it does.
