#!/usr/bin/env bash
# Reproduce every measured claim in this repository.
#
#   sh scripts/verify.sh              # everything
#   sh scripts/verify.sh pipeline     # reconstruction engine only
#   sh scripts/verify.sh api          # capture API only
#   sh scripts/verify.sh web          # built app in a browser only
#   sh scripts/verify.sh docker       # the image's runtime contract only
#
# Exits 0 only if every check passed. One check is EXPECTED to fail and counts as
# a pass only when it fails in the documented way:
#
#   * tests/benchmark_sift.py — the single-pair pose check, deliberately FAIL by
#     design. It is the reason the incremental multi-view path is mandatory.
#
#   * tests/compare_colmap.py, tests/eval_densify.py and
#     tests/eval_registration_rate.py are committed gates that are NOT wired in
#     here. The first two need `colmap` and `open3d`, which CI does not have;
#     the third needs nothing extra but takes ~97s, which would double this
#     section's runtime. All three must be run by hand to reproduce §3b, §3c and
#     §3f; docs/status.md §7 lists the commands.
#
#   * tests/eval_registration_levers.py is an instrument, not a pass/fail gate
#     (like eval_accuracy): it A/B-measures the §3f registration levers against
#     the baseline in one shared gauge, ~109s, and the measured decision was to
#     keep the shipped configuration. Run it by hand; see docs/status.md §3f/§7.
#
# The docker section proves the runtime contract the image encodes (pip pins
# resolve, the image's CMD boots and /api/health answers, the Dockerfile agrees
# with the code). This sandbox and CI have no docker daemon, so the image
# itself is not built here; tests/test_dockerfile.py prints that honestly and
# docs/deployment/docker.md lists what a real build must be checked against.
#
# POSIX sh only (dash has no `pipefail`); CI and the hosting image invoke it with
# `sh`. Requirements: python3 with requirements.txt installed, Node >= 22.5, and
# the ground-truth fixture at $FIXTURE (generated below if absent).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

FIXTURE="${FIXTURE:-/tmp/fx2}"
SECTIONS="${*:-pipeline api web docker}"
FAILED=0

step() {
  echo
  echo "=== $1"
  shift
  if "$@"; then
    echo "--- PASS: $*"
  else
    echo "--- FAIL: $*"
    FAILED=1
  fi
}

expect_failure() {
  name="$1"
  pattern="$2"
  shift 2
  echo
  echo "=== $name (must fail, and fail in the documented way)"
  out="$("$@" 2>&1)"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "--- FAIL: $name was expected to fail but exited 0"
    FAILED=1
  elif ! printf '%s' "$out" | grep -q "$pattern"; then
    echo "--- FAIL: $name failed, but not as documented (wanted output matching: $pattern)"
    printf '%s\n' "$out" | tail -20
    FAILED=1
  else
    echo "--- PASS: $name failed as documented"
    printf '%s\n' "$out" | tail -5
  fi
}

has_section() {
  for s in $SECTIONS; do
    [ "$s" = "$1" ] && return 0
  done
  return 1
}

ensure_fixture() {
  if [ ! -d "$FIXTURE/images" ]; then
    echo "=== generating the ground-truth fixture at $FIXTURE"
    python3 tests/make_fixture.py --out "$FIXTURE" --views 24 --radius 7.0 || exit 1
  fi
}

if has_section pipeline; then
  ensure_fixture
  step "unit suite" python3 -m pytest tests/test_pipeline.py -q
  # The documentation set: no empty directory, no stub, every relative link
  # resolves, and the gate carries its own negative control. Fast and
  # dependency-free, so it belongs in this section.
  step "documentation set is complete and internally linked" \
    python3 tests/test_docs.py
  step "capture coverage is measured from the camera geometry" \
    python3 tests/test_coverage.py
  step "two-view pose recovery is exact" python3 tests/recoverpose_contract.py
  step "N-view triangulation is exact on ground-truth correspondences" \
    python3 tests/test_triangulation.py --fixture "$FIXTURE"
  step "incremental SfM vs ground truth" \
    python3 tests/test_sfm_multiview.py --fixture "$FIXTURE" --views 8
  step "worker end to end, GLB re-validated" \
    python3 tests/test_end_to_end.py --fixture "$FIXTURE" --views 8
  # The notebooks are executable documentation: both notebooks' code cells are
  # executed verbatim and their honesty checks (and negative controls) run.
  # Needs only requirements.txt and ~5s, so it belongs in this section.
  step "notebooks run end to end and match their generated source" \
    python3 tests/test_notebooks.py
  # The baked texture atlas has to earn its place against per-vertex colour,
  # scored against the photographs themselves.
  step "baked texture atlas beats per-vertex colour" \
    python3 -m tests.eval_texture --fixture "$FIXTURE" --views 12
  # The per-photo review has to catch a photo we damaged, measured against a
  # baseline of the clean capture so its false-positive half can actually fail.
  step "per-photo review finds a damaged photo" \
    python3 -m tests.eval_view_quality --fixture "$FIXTURE" --views 12
  # The hand-written descriptor that was rejected: it must stay reproducible,
  # and it must stay worse than OpenCV's SIFT.
  step "rejected hand-written descriptor, for comparison" \
    python3 tests/benchmark_descriptor.py --fixture "$FIXTURE" --pairs 3 4
  # Documented, deliberate failure: one narrow-baseline pair is not enough.
  expect_failure "single view pair pose check" "RESULT: FAIL" \
    python3 tests/benchmark_sift.py --fixture "$FIXTURE" --pair 3 4
  # tests/eval_registration_rate.py is deliberately NOT run here. It needs
  # nothing beyond requirements.txt, so this is not the usual missing-dependency
  # excuse: it is simply too slow. It runs a full structure-from-motion per
  # variant and takes ~97s, which would roughly double this section's runtime
  # and push it past a normal CI budget. Run it by hand; see docs/status.md 7.
fi

if has_section api; then
  ensure_fixture
  step "capture API against the real worker" node --test apps/api/test/api.test.js
  # Accounts, ownership and the share links that replaced "the URL is the
  # credential". Uses a stand-in worker, so it costs nothing to run.
  step "accounts, capture ownership and revocable share links" \
    node --test apps/api/test/auth.test.js
  # Storage: local disk, and Backblaze B2 against a stand-in that implements
  # Backblaze's documented protocol. No account and no credential needed; the
  # real service is exercised by hand (docs/storage/README.md).
  step "captures are stored, and served back, through the configured driver" \
    node --test apps/api/test/storage.test.js
  # Presigned uploads: the API hands out a short-lived URL, the photographs go
  # straight to the store, and the API re-checks every object before a worker
  # is allowed to see it. The driver that cannot presign must say so, not
  # pretend, so the body route stays the fallback.
  step "presigned direct-to-bucket uploads, verified after they land" \
    node --test apps/api/test/direct-upload.test.js
  # Retention: abandoned upload rows and, when a TTL is configured, finished
  # captures are swept. Off by default (CAPTURE_TTL_DAYS=0); the sweep itself
  # is still gated so the code path cannot rot.
  step "time-based retention reaps abandoned uploads and expired captures" \
    node --test apps/api/test/retention.test.js
  # The queue is in memory, so a restart strands whatever it held. Recovery
  # re-queues it from the rows; this also gates what a finished run prunes.
  step "the job runner recovers after a restart and cleans up after a run" \
    node --test apps/api/test/worker.test.js
  step "job time limit" node --test apps/api/test/timeout.test.js
  step "job cancellation (queued and running)" node --test apps/api/test/cancel.test.js
fi

if has_section web; then
  if [ ! -d apps/web/node_modules ]; then
    echo
    echo "=== installing web dependencies"
    (cd apps/web && npm install) || exit 1
  fi
  step "web typecheck and build" sh -c 'cd apps/web && npx tsc -b && npx vite build'
  # The capture ring's geometry, including a check that it agrees with the
  # Python coverage estimator it claims to preview.
  step "capture orbit geometry agrees with the worker's coverage estimator" \
    node --test apps/web/test/orbit.test.ts
  # The cancel affordance's client contract: DELETE to the capture itself,
  # the server's 202 verdict, and the 409 message the UI shows when the
  # capture finished before the cancel arrived.
  step "cancellation client sends DELETE and surfaces the server's verdict" \
    node --test apps/web/test/cancel.test.ts
  # The share-token client contract: a page opened with ?t= must ask the API
  # with that token on every read, and the owner must not need one at all.
  step "share links carry their token on every model request" \
    node --test apps/web/test/share.test.ts
  # The delete-account client contract: a DELETE to the account endpoint with
  # the password in the body, and the server's refusal surfaced as an ApiError.
  step "account deletion asks with DELETE and surfaces the server's refusal" \
    node --test apps/web/test/account.test.ts
  # The direct-upload client contract: decode once, upload each object with the
  # API's headers, complete, and fall back to the request body on any direct
  # failure -- but never on a 401, which would fail the same way twice.
  step "direct uploads from the browser, with the body route as fallback" \
    node --test apps/web/test/direct-upload.test.ts
  step "built app driven in a real browser" node apps/web/e2e/run.mjs
fi

if has_section docker; then
  step "docker image contract: pins resolve, CMD boots, Dockerfile agrees" \
    python3 tests/test_dockerfile.py
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "RESULT: PASS — every check behaved as documented"
else
  echo "RESULT: FAIL — at least one check did not behave as documented"
fi
exit "$FAILED"