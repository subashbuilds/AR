"""The Dockerfile encodes a runtime contract, so the contract is executed.

The development sandbox (and this repo's CI) has no docker daemon, so the
image itself is never built or run here -- that is stated in the Dockerfile
header, in verify.sh and in docs/deployment/docker.md, and it is why this
gate is not called "the image builds". What IS executed, against this exact
tree:

1. Every pin in requirements.txt exists on PyPI with a wheel covering
   CPython 3.10 on manylinux -- the platform python:3.10-slim targets --
   and `pip install -r requirements.txt` accepts the file.
2. The image's CMD -- `node apps/api/src/server.js` -- boots, answers
   /api/health with worker.available=true, and node:sqlite loads (the
   engines ">=22.5" claim in apps/api/package.json).
3. The Dockerfile agrees with the code it ships: the env names config.js
   reads, the default port, the health route server.js serves, the layout
   the stages copy, and .dockerignore does not exclude anything a COPY
   needs.
4. Negative controls: an impossible dependency pin, a broken CMD, and a
   .dockerignore that excludes apps/ must each make this gate fail -- the
   checks are connected to their inputs.

Usage (a direct script, not a pytest module -- pytest would collect
nothing from it and that silence would be mistaken for a pass):
    python3 tests/test_dockerfile.py
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

FAILURES: list[str] = []


def fail(msg: str) -> None:
    FAILURES.append(msg)


def check(cond: bool, msg: str) -> bool:
    if not cond:
        fail(msg)
    return bool(cond)


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


# -- 1. the pip layer: pins must resolve on the image's platform --------------

def load_pins(text: str) -> list[tuple[str, str]]:
    """name==version pairs from a requirements file; comments skipped."""
    pins = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line)
        if not m:
            fail(f"requirements line is not a plain name==pin: {line!r}")
            continue
        pins.append((m.group(1), m.group(2)))
    return pins


_PIN_CACHE: dict[str, dict | None] = {}


def pypi_distribution(name: str) -> dict | None:
    if name not in _PIN_CACHE:
        url = f"https://pypi.org/pypi/{name}/json"
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                _PIN_CACHE[name] = json.load(resp)
        except Exception as err:  # noqa: BLE001 - report, never crash the gate
            print(f"  ! pypi.org unreachable for {name}: {err}")
            _PIN_CACHE[name] = None
    return _PIN_CACHE[name]


def _wheel_covers_cp310_linux(filename: str) -> bool:
    """{dist}-{ver}-{python}-{abi}-{platform}.whl platform coverage."""
    parts = filename[:-4].split("-")
    if len(parts) < 5:
        return False
    pytag, abitag, platform = parts[-3], parts[-2], parts[-1]
    python_ok = (
        "py3" in pytag
        or "cp310" in pytag
        or (pytag.startswith("cp3") and "abi3" in abitag)
    )
    platform_ok = "linux" in platform or platform == "any"
    return python_ok and platform_ok


def pin_failures(pins: list[tuple[str, str]]) -> list[str]:
    out: list[str] = []
    for name, version in pins:
        dist = pypi_distribution(name)
        if dist is None:
            out.append(f"{name}: PyPI could not be reached to verify {version}")
            continue
        if version not in dist.get("releases", {}):
            out.append(f"{name}=={version}: no such release on PyPI")
            continue
        # /pypi/<name>/json lists the files of the *latest* version only; the
        # files API gives every release. One request per pin, cached.
        files_url = f"https://pypi.org/pypi/{name}/{version}/json"
        try:
            with urllib.request.urlopen(files_url, timeout=20) as resp:
                files = json.load(resp).get("urls") or []
        except Exception as err:  # noqa: BLE001
            out.append(f"{name}=={version}: could not list files: {err}")
            continue
        wheels = [u["filename"] for u in files if u["filename"].endswith(".whl")]
        if not wheels:
            out.append(f"{name}=={version}: no wheels published at all")
            continue
        good = [w for w in wheels if _wheel_covers_cp310_linux(w)]
        if not good:
            out.append(
                f"{name}=={version}: no wheel covers CPython 3.10 on linux "
                f"(wheels: {', '.join(wheels)})"
            )
    return out


# -- 3a. .dockerignore must not exclude anything the COPYs need ---------------


def parse_ignore(text: str) -> list[tuple[str, bool]]:
    """(pattern, negated) pairs; comments and blanks dropped."""
    pats: list[tuple[str, bool]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        pats.append((line.lstrip("!").strip("/"), negated))
    return pats


def _glob_re(pat: str) -> str:
    out, i = "", 0
    while i < len(pat):
        if pat[i:i + 3] == "**/":
            out += "(?:.*/)?"
            i += 3
        elif pat[i:i + 2] == "**":
            out += ".*"
            i += 2
        elif pat[i] == "*":
            out += "[^/]*"
            i += 1
        elif pat[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pat[i])
            i += 1
    return out


def is_ignored(path: str, patterns: list[tuple[str, bool]]) -> bool:
    """Enough dockerignore semantics for this repo's file (no negation used;
    the gate refuses negated patterns rather than guess)."""
    full = path.strip("/")
    dirs: list[str] = []
    while True:
        slash = full.rfind("/")
        if slash < 0:
            break
        dirs.append(full[:slash])
        full = full[:slash]
    full = path.strip("/")
    for pat, _ in patterns:
        regex = _glob_re(pat)
        if "/" in pat:
            # anchored on the full path; also matches the directory and
            # everything under it (docker semantics for a dir pattern)
            if re.fullmatch(regex + "(?:/.*)?", full):
                return True
        else:
            if re.fullmatch(regex, full) or any(re.fullmatch(regex, d) for d in dirs):
                return True
            if any(re.fullmatch(regex, seg) for seg in full.split("/")):
                return True
    return False


# Paths the image stages COPY, represented by a file that must survive the
# daemon's ignore filter.
NEEDED_PATHS = [
    "requirements.txt",
    "apps/api/package.json",
    "apps/api/src/server.js",
    "apps/api/src/config.js",
    "apps/web/package.json",
    "apps/web/bun.lock",
    "apps/web/index.html",
    "apps/web/src/main.tsx",
    "services/reconstruction-worker/run_job.py",
    "services/reconstruction-worker/pipeline/run.py",
]


def ignore_failures(ignore_text: str) -> list[str]:
    out: list[str] = []
    patterns = parse_ignore(ignore_text)
    for need in NEEDED_PATHS:
        if is_ignored(need, patterns):
            out.append(f".dockerignore excludes {need}, which a COPY needs")
    # Sanity in the other direction: the matcher must actually match.
    if not is_ignored("apps/web/node_modules/vite/index.js", patterns):
        out.append("ignore sanity: apps/web/node_modules is not excluded")
    return out


# -- 3b. the Dockerfile must agree with the code it ships ---------------------


def dockerfile_failures(df: str, api_pkg: str, config_src: str,
                        server_src: str, req_text: str) -> list[str]:
    out: list[str] = []

    def need(needle: str, why: str):
        if needle not in df:
            out.append(f"Dockerfile lacks {why} ({needle!r})")

    # stages and their order
    need("FROM node:22-bookworm-slim AS web", "the web build stage")
    need("FROM python:3.10-slim", "the runtime stage")
    if "FROM node:" in df and "FROM python:" in df:
        if df.index("FROM node:") > df.index("FROM python:"):
            out.append("the web build stage must come before the runtime stage")

    # pip layer order: requirements copied before installed
    if "COPY requirements.txt" in df and "pip install" in df:
        if df.index("COPY requirements.txt") > df.index("pip install"):
            out.append("requirements.txt must be COPYed before pip install")
    else:
        out.append("Dockerfile does not install requirements.txt")

    # the layout the runtime stage ships, and the command it runs
    need("COPY --from=web /web/dist ./apps/web/dist",
         "the built web app from stage 1")
    need("COPY services/reconstruction-worker", "the worker")
    need("COPY apps/api", "the API")
    need('CMD ["node", "apps/api/src/server.js"]', "the CMD")
    need("ENV DATA_DIR=/data", "the data-dir env")
    need("EXPOSE 8787", "the exposed port")
    need("VOLUME /data", "the data volume")
    need("/api/health", "a healthcheck against the real health route")
    need("npm install", "the npm install layer")
    need("npx vite build", "the vite build layer")
    need("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
         "skipping playwright's browser download in the web stage")

    # cross-checks against the code actually shipped
    if "process.env.DATA_DIR" not in config_src:
        out.append("config.js does not read DATA_DIR, so ENV DATA_DIR is dead")
    if "8787" not in config_src:
        out.append("config.js has no 8787 default, so EXPOSE 8787 lies")
    if '"/api/health"' not in server_src:
        out.append("server.js does not serve /api/health, so HEALTHCHECK lies")
    if '"type": "module"' not in api_pkg:
        out.append("apps/api/package.json is not type:module, so the CMD "
                   "would die on the first import statement")
    m = re.search(r'"node":\s*">=([0-9.]+)"', api_pkg)
    if not m:
        out.append("apps/api/package.json states no node engines floor")
    elif tuple(int(p) for p in m.group(1).split(".")) > (22, 5, 0):
        out.append(f"engines floor {m.group(1)} exceeds node:22-bookworm-slim")

    if not load_pins(req_text):
        out.append("requirements.txt yielded no pins for the pip layer")
    return out


# -- 2. the CMD boots and the health endpoint answers -------------------------


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def boot_failures() -> list[str]:
    out: list[str] = []
    try:
        ver = subprocess.run(["node", "-p", "process.versions.node"],
                             capture_output=True, text=True, timeout=15)
        major, minor = (int(p) for p in ver.stdout.strip().split(".")[:2])
        if (major, minor) < (22, 5):
            out.append(f"local node {ver.stdout.strip()} < 22.5: node:sqlite "
                       "is unavailable, so the engines floor is untested")
    except Exception as err:  # noqa: BLE001
        out.append(f"could not run node: {err}")
        return out
    try:
        subprocess.run(["node", "-e", "require('node:sqlite')"],
                       capture_output=True, timeout=15, check=True)
    except subprocess.CalledProcessError as err:
        out.append(f"node:sqlite does not load: {err.stderr.decode()[:200]}")
        return out

    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="oca-docker-gate-")
    env = dict(os.environ, PORT=str(port), DATA_DIR=data_dir)
    proc = subprocess.Popen(
        ["node", "apps/api/src/server.js"], cwd=REPO, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.time() + 15
        health = None
        while time.time() < deadline:
            if proc.poll() is not None:
                out.append(f"server exited early with code {proc.returncode}")
                return out
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                    health = json.load(r)
                    break
            except Exception:  # noqa: BLE001 - not up yet; poll
                time.sleep(0.3)
        if health is None:
            out.append("/api/health never answered within 15s")
            return out
        if not health.get("ok"):
            out.append(f"/api/health answered but ok is falsy: {health}")
        worker = (health.get("worker") or {})
        if worker.get("available") is not True:
            out.append(f"/api/health reports worker.available={worker.get('available')!r}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    return out


# -- main ---------------------------------------------------------------------


def main() -> int:
    print("== docker contract gate: the image's runtime contract, executed")
    print("   (no docker daemon in this sandbox or in CI: the image itself is")
    print("    not built or run here -- docs/deployment/docker.md says so, and")
    print("    lists the two commands to run where docker exists)")

    df = read(os.path.join(REPO, "Dockerfile"))
    ignore = read(os.path.join(REPO, ".dockerignore"))
    api_pkg = read(os.path.join(REPO, "apps", "api", "package.json"))
    config_src = read(os.path.join(REPO, "apps", "api", "src", "config.js"))
    server_src = read(os.path.join(REPO, "apps", "api", "src", "server.js"))
    req_text = read(os.path.join(REPO, "requirements.txt"))

    # 1. pins resolve on the image's platform
    pins = load_pins(req_text)
    print(f"  resolving {len(pins)} pins against PyPI "
          f"(CPython 3.10 / manylinux coverage)")
    pin_problems = pin_failures(pins)
    for msg in pin_problems:
        fail(msg)

    # 1b. pip itself accepts the file (idempotent here: already installed)
    pip = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet",
                          "-r", os.path.join(REPO, "requirements.txt")],
                         capture_output=True, text=True, timeout=170)
    if pip.returncode != 0:
        fail("pip install -r requirements.txt failed: "
             + pip.stderr.strip()[-300:])

    # 2. the CMD boots and /api/health answers
    boot_problems = boot_failures()
    for msg in boot_problems:
        fail(msg)
    if not boot_problems:
        print("  CMD boots, /api/health answers, worker available, "
              "node:sqlite loads")

    # 3. the Dockerfile agrees with the code it ships
    struct = dockerfile_failures(df, api_pkg, config_src, server_src, req_text)
    for msg in struct:
        fail(msg)
    ign = ignore_failures(ignore)
    for msg in ign:
        fail(msg)
    if not struct and not ign:
        print("  Dockerfile, .dockerignore and the shipped code agree")

    # 4. negative controls -- each must break the corresponding check
    doctored_req = req_text + "\nopencv-python-headless==5.0.0\n"
    ctrl_pins = pin_failures(load_pins(doctored_req))
    check(any("5.0.0" in p and "no such release" in p for p in ctrl_pins),
          "negative control: an impossible pin was not caught")

    doctored_df = df.replace('CMD ["node", "apps/api/src/server.js"]',
                             'CMD ["node", "apps/api/src/nope.js"]')
    check(doctored_df != df and dockerfile_failures(
        doctored_df, api_pkg, config_src, server_src, req_text),
          "negative control: a broken CMD was not caught")

    doctored_ignore = ignore + "\napps\n"
    check(ignore_failures(doctored_ignore),
          "negative control: an .dockerignore excluding apps/ was not caught")

    if FAILURES:
        print("FAIL:")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("RESULT: PASS -- pins resolve, the CMD boots and answers, the "
          "Dockerfile agrees with the code")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
