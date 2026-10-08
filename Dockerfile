# ObjectCapture AR — API + reconstruction worker + built web app.
#
# Multi-stage:
#   1. web     — builds the capture app with Node (npm + vite build)
#   2. runtime — Python (worker deps) + Node (API); serves the built app
#
# No model weights, no COLMAP, no GPU: the pipeline is OpenCV + numpy/scipy.
# Build from the repository root (this file's directory):
#
#   docker build -t objectcapture-ar .
#   docker run --rm -p 8787:8787 -v oca-data:/data objectcapture-ar
#
# HOW THIS FILE WAS VERIFIED (read before trusting it): the development
# sandbox has no docker daemon, so the image itself has never been built
# here. What IS verified by execution is the runtime contract the image
# encodes — tests/test_dockerfile.py checks the provisioning (a fresh
# resolution of requirements.txt), the worker imports, and the API start
# contract (node:sqlite present, /api/health answers) against this exact
# tree. The Dockerfile and the gate are meant to be read together; see
# docs/deployment/docker.md.

# ---- stage 1: the capture app ----------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
# playwright sits in devDependencies for the e2e suite; the image does not run
# it, and its postinstall would otherwise download three browsers into a layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Dependencies first so source edits do not invalidate the npm layer. The
# project pins with bun.lock; npm reads package.json and produces an
# equivalent install (verify.sh does the same).
COPY apps/web/package.json apps/web/bun.lock ./
RUN npm install --no-audit --no-fund
COPY apps/web/ ./
RUN npx vite build

# ---- stage 2: runtime -------------------------------------------------------
FROM python:3.10-slim

# Node 22 (the API uses node:sqlite, which needs >= 22.5) on top of the
# Python image the worker was verified with.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl gnupg libgl1 libglib2.0-0 \
    && install -d /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
         | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
         > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Worker dependencies: this layer only changes when requirements.txt does.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/reconstruction-worker ./services/reconstruction-worker
COPY apps/api ./apps/api
COPY --from=web /web/dist ./apps/web/dist

# Captures, job state and GLBs live here; mount a volume so models survive
# container replacement.
ENV DATA_DIR=/data \
    PYTHONUNBUFFERED=1
RUN mkdir -p /data
VOLUME /data

EXPOSE 8787

# The API's own readiness endpoint, the one the browser run and CI use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=4); sys.exit(0 if r.status==200 else 1)"

CMD ["node", "apps/api/src/server.js"]
