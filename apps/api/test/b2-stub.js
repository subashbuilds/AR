// A stand-in Backblaze B2 server, speaking the v4 NATIVE API.
//
//   const stub = await startB2Stub()
//   // point B2_ENDPOINT at stub.base, and the driver does the rest
//
// It exists so the B2 driver can be exercised for real -- request shapes, the
// Basic auth on b2_authorize_account, the percent-encoded X-Bz-File-Name, the
// X-Bz-Content-Sha1 that B2 verifies, the 401-then-reauthorise path, deletions
// by (fileName, fileId) -- without an account, a bucket or a credential.
//
// It is NOT a mock of the driver: it is an implementation of the other side of
// the documented protocol, and every request it answers is recorded so a test
// can assert what actually went over the wire. Where its behaviour could drift
// from Backblaze's, the comment says which documented rule it is standing in
// for.

import http from "node:http";
import crypto from "node:crypto";

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function b2Error(res, status, code, message) {
  send(res, status, { status, code, message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function startB2Stub(options = {}) {
  const state = {
    /** fileName -> { bytes, contentType, sha1, fileId } */
    objects: new Map(),
    /** Every request, in order: method, path, query, headers, body. */
    requests: [],
    authorizeCount: 0,
    uploadUrlCount: 0,
    listBucketsCount: 0,
    /** Bumped by a test to invalidate every token already issued. */
    epoch: 1,
    /** A key with no bucket restriction: the driver must call b2_list_buckets. */
    unrestrictedKey: Boolean(options.unrestrictedKey),
    /** Make the next upload reject its SHA1, as B2 does on corruption. */
    rejectSha1: false,
    /** Refuse every upload, for the "photographs could not be stored" path. */
    failUploads: false,
    /** Refuse only the uploads this predicate matches, e.g. the model alone. */
    failUploadFor: null,
  };

  const keyId = options.keyId || "test-key-id";
  const applicationKey = options.applicationKey || "test-application-key";
  const bucketName = options.bucketName || "oca-test";
  const bucketId = "4a48fe8875c6214145260818";
  const accountToken = () => `acct-${state.epoch}`;
  const uploadToken = () => `upld-${state.epoch}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://stub");
    const pathname = url.pathname;
    const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
    state.requests.push({
      method: req.method,
      path: pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });

    // ---- b2_authorize_account -------------------------------------------
    if (pathname === "/b2api/v4/b2_authorize_account") {
      const expected = `Basic ${Buffer.from(`${keyId}:${applicationKey}`).toString("base64")}`;
      if (req.headers.authorization !== expected) {
        return b2Error(res, 401, "unauthorized", "The applicationKeyId and/or the applicationKey are wrong.");
      }
      state.authorizeCount += 1;
      const base = `http://127.0.0.1:${server.address().port}`;
      return send(res, 200, {
        accountId: "stub-account",
        apiInfo: {
          storageApi: {
            apiUrl: base,
            downloadUrl: base,
            s3ApiUrl: `${base}/s3`,
            absoluteMinimumPartSize: 5000000,
            recommendedPartSize: 100000000,
            // A bucket-restricted key names its buckets here; an unrestricted
            // one returns [] and the driver has to ask b2_list_buckets.
            allowed: {
              buckets: state.unrestrictedKey ? [] : [{ id: bucketId, name: bucketName }],
              capabilities: ["listFiles", "readFiles", "writeFiles", "deleteFiles", "listBuckets"],
              namePrefix: null,
            },
          },
        },
        authorizationToken: accountToken(),
        applicationKeyExpirationTimestamp: null,
      });
    }

    const token = req.headers.authorization;

    // ---- b2_list_buckets -------------------------------------------------
    if (pathname === "/b2api/v4/b2_list_buckets") {
      if (token !== accountToken()) return b2Error(res, 401, "expired_auth_token", "expired");
      state.listBucketsCount += 1;
      const asked = JSON.parse(body.toString("utf8") || "{}");
      const buckets =
        asked.bucketName === bucketName ? [{ accountId: "stub-account", bucketId, bucketName, bucketType: "allPrivate" }] : [];
      return send(res, 200, { buckets });
    }

    // ---- b2_get_upload_url ----------------------------------------------
    if (pathname === "/b2api/v4/b2_get_upload_url") {
      if (token !== accountToken()) return b2Error(res, 401, "expired_auth_token", "expired");
      if (url.searchParams.get("bucketId") !== bucketId) {
        return b2Error(res, 400, "bad_bucket_id", "The requested bucket ID does not match an existing bucket.");
      }
      state.uploadUrlCount += 1;
      return send(res, 200, {
        bucketId,
        uploadUrl: `http://127.0.0.1:${server.address().port}/upload/${bucketId}`,
        authorizationToken: uploadToken(),
      });
    }

    // ---- b2_upload_file (the uploadUrl B2 handed back) -------------------
    if (pathname === `/upload/${bucketId}`) {
      if (token !== uploadToken()) return b2Error(res, 401, "bad_auth_token", "expired upload token");
      // The name is percent-encoded UTF-8 and carries the extension B2 stores.
      const rawName = req.headers["x-bz-file-name"];
      if (!rawName) return b2Error(res, 400, "bad_request", "X-Bz-File-Name is required");
      const name = decodeURIComponent(String(rawName));
      if (state.failUploads) return b2Error(res, 503, "service_unavailable", "storage unavailable");
      if (state.failUploadFor && state.failUploadFor(name)) {
        return b2Error(res, 503, "service_unavailable", `storage unavailable for ${name}`);
      }
      const sha1 = crypto.createHash("sha1").update(body).digest("hex");
      const claimed = req.headers["x-bz-content-sha1"];
      if (state.rejectSha1 || claimed !== sha1) {
        // This is exactly what B2 does with a checksum it cannot verify.
        return b2Error(res, 400, "bad_request", "Sha1 did not match data received");
        }
      if (String(req.headers["content-length"]) !== String(body.length)) {
        return b2Error(res, 411, "bad_request", "Content-Length does not match the body");
      }
      const fileId = `stub-file-${state.objects.size + 1}_${sha1.slice(0, 8)}`;
      state.objects.set(name, {
        bytes: body,
        contentType: req.headers["content-type"] || "b2/x-auto",
        sha1,
        fileId,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "2",
        "x-bz-file-id": fileId,
        "x-bz-file-name": String(rawName),
        "x-bz-content-sha1": sha1,
      });
      return res.end("{}");
    }

    // ---- b2_list_file_names ----------------------------------------------
    if (pathname === "/b2api/v4/b2_list_file_names") {
      if (token !== accountToken()) return b2Error(res, 401, "expired_auth_token", "expired");
      if (url.searchParams.get("bucketId") !== bucketId) {
        return b2Error(res, 400, "bad_bucket_id", "unknown bucket");
      }
      const prefix = url.searchParams.get("prefix") || "";
      const files = [...state.objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fileName, object]) => ({
          fileName,
          fileId: object.fileId,
          contentLength: object.bytes.length,
          contentType: object.contentType,
          uploadTimestamp: Date.now(),
        }));
      return send(res, 200, { files, nextFileName: null });
    }

    // ---- b2_delete_file_version -----------------------------------------
    if (pathname === "/b2api/v4/b2_delete_file_version") {
      if (token !== accountToken()) return b2Error(res, 401, "expired_auth_token", "expired");
      const asked = JSON.parse(body.toString("utf8") || "{}");
      const object = state.objects.get(asked.fileName);
      if (!object || object.fileId !== asked.fileId) {
        return b2Error(res, 400, "file_not_present", `File not present: ${asked.fileName} ${asked.fileId}`);
      }
      state.objects.delete(asked.fileName);
      return send(res, 200, { fileId: object.fileId, fileName: asked.fileName });
    }

    // ---- b2_download_file_by_name ---------------------------------------
    const download = /^\/file\/([^/]+)\/(.+)$/.exec(pathname);
    if (download) {
      const [, askedBucket, encodedName] = download;
      if (askedBucket !== bucketName) return b2Error(res, 404, "not_found", "no such bucket");
      const name = decodeURIComponent(encodedName);
      const object = state.objects.get(name);
      if (!object) return b2Error(res, 404, "not_found", "File not present");
      // An account token was required for a private bucket; without one, this
      // stub refuses rather than pretending the bucket is public.
      if (token !== accountToken()) return b2Error(res, 401, "bad_auth_token", "authorization required");
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": object.contentType,
          "content-length": String(object.bytes.length),
          "x-bz-content-sha1": object.sha1,
        });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(String(range));
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] !== "" ? Number(m[2]) : object.bytes.length - 1;
        const slice = object.bytes.subarray(start, end + 1);
        res.writeHead(206, {
          "content-type": object.contentType,
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${object.bytes.length}`,
        });
        return res.end(slice);
      }
      res.writeHead(200, {
        "content-type": object.contentType,
        "content-length": String(object.bytes.length),
        "x-bz-content-sha1": object.sha1,
      });
      return res.end(object.bytes);
    }

    return b2Error(res, 404, "not_found", `no such stub endpoint: ${pathname}`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    state,
    keyId,
    applicationKey,
    bucketName,
    bucketId,
    /** Names of everything currently in the bucket. */
    names() {
      return [...state.objects.keys()].sort();
    },
    get(name) {
      return state.objects.get(name) || null;
    },
    /** Requests to one path, for asserting exactly what the driver sent. */
    seen(pathname) {
      return state.requests.filter((r) => r.path === pathname);
    },
    close() {
      return new Promise((resolve) => {
        // The driver's HTTP client keeps idle sockets open (keep-alive), and
        // server.close() waits for them: without this the gate would sit for
        // seconds per test and eventually look like a hang.
        server.closeAllConnections?.();
        server.close(resolve);
      });
    },
  };
}
