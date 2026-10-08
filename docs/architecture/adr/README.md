# Architecture decision records

Short records of the decisions that were *made* rather than inherited, each
with the measurement that justified it. Status values: `accepted` (shipped),
`closed` (candidate measured and rejected — the decision stands).

| # | Decision | Status |
|---|---|---|
| [0001](0001-sparse-incremental-sfm-over-dense-mvs.md) | Sparse incremental SfM; dense MVS stays closed | closed (5–6 Oct) |
| [0002](0002-single-gauge-transform.md) | One defined reconstruction→ground-truth transform; the wrong-gauge rule | accepted |
| [0003](0003-registration-defaults-stand.md) | Registration defaults stand after five levers were measured | closed (6 Oct) |
| [0004](0004-no-fallback-model.md) | No fallback model: a failed stage is named, never retried into success | accepted |
| [0005](0005-accounts-and-revocable-share-links.md) | First-party accounts, and a share link that is not the URL | accepted (7 Oct) |
| [0006](0006-backblaze-b2-over-r2.md) | Backblaze B2 over its native API, behind one storage driver | accepted (7 Oct) |
| [0007](0007-direct-uploads-and-retention.md) | Direct-to-bucket uploads, verified after they land; retention that is off by default | accepted (7 Oct) |

Format: Context / Decision / Consequences. Every number cited here is
reproduced by a gate listed in `docs/status.md` §7.
