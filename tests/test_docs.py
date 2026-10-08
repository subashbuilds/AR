"""The documentation set must be complete and internally consistent.

    python3 tests/test_docs.py          # exits 0 when the set is whole

Three checks, each of which has failed on this repository at least once in
spirit — empty `docs/` directories existed for weeks, and a broken relative
link is the kind of rot nobody notices until a reader hits it:

  1. No empty directory anywhere under `docs/` — an empty directory is a
     promise the repository has not kept (the ~22-document deliverable).
  2. Every `docs/**/*.md` file is non-empty and starts with a `#` heading —
     no stubs, no marker files.
  3. Every RELATIVE markdown link `[text](path)` in `docs/**/*.md` resolves
     to a file that exists, relative to the file that declares it. External
     links (http/https/mailto), pure-fragment anchors and site-root routes
     (`/capture`) are skipped: those are checked elsewhere (the e2e drives
     the routes) or are the reader's network's problem.

Negative control: a synthetic tree with one empty directory and one broken
link must FAIL both checks — a gate that cannot fail is not wired in.

Exits 0 on success, 1 on any finding. Fast (<1s), no dependencies beyond
the standard library, so it belongs in verify.sh's pipeline section.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")

LINK_RE = re.compile(r"\]\(([^)\s]+)\)")


def empty_dirs(base: str) -> list[str]:
    found = []
    for dirpath, _dirnames, filenames in os.walk(base):
        if not _dirnames and not filenames:
            found.append(os.path.relpath(dirpath, base))
    return sorted(found)


def md_files(base: str) -> list[str]:
    out = []
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in filenames:
            if name.endswith(".md"):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def broken_links(path: str) -> list[str]:
    """Relative links in `path` that do not resolve to an existing file."""
    base = os.path.dirname(path)
    bad = []
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    for target in LINK_RE.findall(text):
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            continue  # external, fragment-only, or a site route
        clean = target.split("#", 1)[0]
        if not clean:
            continue
        if not os.path.exists(os.path.normpath(os.path.join(base, clean))):
            bad.append(target)
    return bad


def check_tree(base: str) -> tuple[list[str], list[str]]:
    """Returns (empty-directory findings, broken-link findings)."""
    empties = [f"empty directory: docs/{d}" if d != "." else "docs/ is empty"
               for d in empty_dirs(base)]
    stubs = []
    links = []
    files = md_files(base)
    if not files:
        stubs.append("no markdown files at all")
    for path in files:
        rel = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        if not text.strip():
            stubs.append(f"empty document: {rel}")
        elif not text.lstrip().startswith("#"):
            stubs.append(f"document without a heading: {rel}")
        for target in broken_links(path):
            links.append(f"broken link in {rel}: {target}")
    return empties + stubs, links


def main() -> int:
    empties, links = check_tree(DOCS)
    for line in empties + links:
        print(f"FAIL  {line}")
    if empties or links:
        print(f"RESULT: FAIL — {len(empties)} structural, {len(links)} link "
              "finding(s)")
        return 1

    # Negative control: the gate must be able to fail. A throwaway tree with
    # one empty directory and one dangling link has to produce both findings.
    tmp = tempfile.mkdtemp(prefix="oca-docs-")
    try:
        os.makedirs(os.path.join(tmp, "empty_dir"))
        with open(os.path.join(tmp, "a.md"), "w", encoding="utf-8") as fh:
            fh.write("# heading\n\n[dead](missing.md)\n")
        ctrl_empty, ctrl_links = check_tree(tmp)
        if not ctrl_empty or not ctrl_links:
            print("RESULT: FAIL — negative control passed unnoticed "
                  f"(empty={ctrl_empty}, links={ctrl_links})")
            return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    n_files = len(md_files(DOCS))
    print(f"    {n_files} documents, no empty directories, every relative "
          "link resolves")
    print("RESULT: PASS — the documentation set is complete and consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
