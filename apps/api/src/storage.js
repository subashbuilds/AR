// Where a capture's bytes live.
//
// One interface, two drivers:
//
//   LocalStorage   files under DATA_DIR. The default, and what runs today.
//   B2Storage      Backblaze B2, over its NATIVE API v4 (not the S3-compatible
//                  one), with global `fetch` and node:crypto only -- so the
//                  service stays dependency-free.
//
// Why the native API rather than S3: this service already speaks plain HTTP and
// has no AWS SDK, and the native API needs exactly four calls
// (b2_authorize_account, b2_get_upload_url, b2_upload_file, b2_delete_file_version)
// plus two more for reads and listings. SigV4 signing would be a second
// authentication scheme to get right, for no capability this needs.
//
// What "durable" means here, precisely: the *published* artifacts of a capture
// (its photographs, result.json and model.glb) are written to the configured
// store, and `completed` is not reported until they are there. The worker still
// needs a real filesystem for its inputs and outputs, so a local working copy
// always exists under DATA_DIR; with a remote driver that copy is a cache, and
// the read path falls back to the remote object when the local file is gone.
//
// The API contract implemented below, from Backblaze's own v4 documentation:
//   GET  {endpoint}/b2api/v4/b2_authorize_account     Basic base64(keyId:key)
//   POST {apiUrl}/b2api/v4/b2_list_buckets            {accountId, bucketName}
//   GET  {apiUrl}/b2api/v4/b2_get_upload_url          ?bucketId=
//   POST {uploadUrl}                                  X-Bz-File-Name, X-Bz-Content-Sha1
//   GET  {apiUrl}/b2api/v4/b2_list_file_names         ?bucketId=&prefix=
//   POST {apiUrl}/b2api/v4/b2_delete_file_version     {fileName, fileId}
//   GET  {downloadUrl}/file/{bucketName}/{fileName}   (HEAD for headers only)

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** Every key this application writes, so nothing else can be addressed. */
export const CAPTURE_PREFIX = "captures/";

export function captureKey(id, rel) {
  return `${CAPTURE_PREFIX}${id}/${rel}`;
}

const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function contentTypeFor(name) {
  const ext = path.extname(name).replace(/^\./, "").toLowerCase();
  return IMAGE_TYPES[ext] || (ext === "glb" ? "model/gltf-binary" : ext === "json" ? "application/json" : "application/octet-stream");
}

/**
 * The extension for an image media type, or null when it is not one this
 * product accepts. Used when a client declares what it is about to upload,
 * before the bytes exist here to sniff.
 */
export function extensionFor(contentType) {
  return IMAGE_EXT[String(contentType || "").split(";")[0].trim().toLowerCase()] || null;
}

/** Reject any key that could escape the storage root. Defence in depth. */
function assertSafeKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw Object.assign(new Error("storage key must be a non-empty string"), { statusCode: 500 });
  }
  if (key.startsWith("/") || key.includes("..") || key.includes("\\") || key.includes("\0")) {
    throw Object.assign(new Error(`storage key is not allowed: ${key}`), { statusCode: 500 });
  }
  return key;
}

export class LocalStorage {
  constructor({ root, prefix = "" } = {}) {
    if (!root) throw new Error("LocalStorage needs a root directory");
    this.kind = "local";
    this.root = root;
    this.prefix = prefix;
    /** There is no URL a browser could be trusted to upload to at a file path. */
    this.supportsDirectUploads = false;
    fs.mkdirSync(root, { recursive: true });
  }

  describe() {
    return { kind: this.kind, durable: false, root: this.root, prefix: this.prefix };
  }

  localFile(key) {
    return path.join(this.root, assertSafeKey(key));
  }

  async put(key, bytes, { contentType } = {}) {
    const file = this.localFile(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, bytes);
    return { key, bytes: bytes.length, contentType: contentType || contentTypeFor(key) };
  }

  async putFile(key, localPath, options = {}) {
    const file = this.localFile(key);
    if (path.resolve(file) === path.resolve(localPath)) {
      const stat = await fsp.stat(localPath); // already in place; nothing to copy
      return { key, bytes: stat.size, contentType: options.contentType || contentTypeFor(key) };
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.copyFile(localPath, file);
    const stat = await fsp.stat(file);
    return { key, bytes: stat.size, contentType: options.contentType || contentTypeFor(key) };
  }

  /** `null` when the object is not there, never an exception. */
  async head(key) {
    try {
      const stat = await fsp.stat(this.localFile(key));
      return { key, length: stat.size, contentType: contentTypeFor(key) };
    } catch {
      return null;
    }
  }

  async open(key, { range } = {}) {
    const file = this.localFile(key);
    const head = await this.head(key);
    if (!head) return null;
    let start = 0;
    let end = head.length - 1;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        start = Number(m[1]);
        end = m[2] === "" ? head.length - 1 : Number(m[2]);
      }
    }
    return {
      key,
      status: range ? 206 : 200,
      length: Math.max(0, end - start + 1),
      contentType: head.contentType,
      stream: fs.createReadStream(file, { start, end }),
    };
  }

  async list(prefix = CAPTURE_PREFIX) {
    const dir = path.join(this.root, prefix);
    let names;
    try {
      names = await walk(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const stat = await fsp.stat(name);
      const key = path.relative(this.root, name).split(path.sep).join("/");
      out.push({ key, length: stat.size, contentType: contentTypeFor(key) });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async remove(key) {
    try {
      await fsp.rm(this.localFile(key), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * There is no presigned upload for local disk: the caller is told so rather
   * than handed a path a browser could never write to. The API answers
   * `direct: false` and the client keeps using the request-body path.
   */
  presign() {
    return null;
  }

  /**
   * Delete every object under a key prefix. Used when a capture -- or a whole
   * account -- is deleted: the bytes must go with the row, in every driver.
   * Returns how many objects were removed.
   */
  async removeAll(prefix = CAPTURE_PREFIX) {
    let removed = 0;
    for (const object of await this.list(prefix)) {
      if (await this.remove(object.key)) removed += 1;
    }
    return removed;
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Backblaze B2, native API v4.
 *
 * `endpoint` is the base for the *account-level* calls; the upload and download
 * hosts come back from b2_authorize_account, exactly as the documentation
 * requires, so a bucket on any cluster works without configuration. It is
 * overridable only so a test can point the whole surface at a stand-in server.
 */
export class B2Storage {
  constructor({ keyId, applicationKey, bucket, prefix = "", endpoint = "https://api.backblazeb2.com", fetchImpl } = {}) {
    for (const [name, value] of Object.entries({ keyId, applicationKey, bucket })) {
      if (!value) throw new Error(`B2Storage needs ${name}`);
    }
    this.kind = "b2";
    /** B2's upload URL is bucket-scoped and safe to hand to an owner. */
    this.supportsDirectUploads = true;
    this.keyId = keyId;
    this.applicationKey = applicationKey;
    this.bucketName = bucket;
    this.prefix = prefix;
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.fetch = fetchImpl || globalThis.fetch;
    /** Cached b2_authorize_account result; the token lives at most 24 hours. */
    this.authorization = null;
    /** Cached bucket id, resolved once from the key or b2_list_buckets. */
    this.bucketId = null;
    /** Cached upload URL + its token, valid 24 hours. */
    this.uploadTarget = null;
    this.requests = 0;
  }

  describe() {
    // The key is never part of what a client or a log may see.
    return {
      kind: this.kind,
      durable: true,
      bucket: this.bucketName,
      prefix: this.prefix,
      endpoint: this.endpoint,
    };
  }

  /** No local file for a remote object; the read path then goes over HTTP. */
  localFile() {
    return null;
  }

  keyFor(key) {
    return this.prefix ? `${this.prefix.replace(/\/+$/, "")}/${assertSafeKey(key)}` : assertSafeKey(key);
  }

  percentEncode(name) {
    // Per the API: the name is percent-encoded UTF-8; "/" stays a separator.
    return String(name)
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
  }

  async call(url, init = {}) {
    this.requests += 1;
    const res = await this.fetch(url, init);
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const code = (body && body.code) || `http_${res.status}`;
      const message = (body && body.message) || text.slice(0, 200) || "no body";
      const err = new Error(`B2 ${code}: ${message}`);
      err.statusCode = res.status === 401 || res.status === 403 ? 502 : res.status;
      err.b2 = { status: res.status, code, message };
      throw err;
    }
    return body;
  }

  async authorise() {
    if (this.authorization) return this.authorization;
    const basic = Buffer.from(`${this.keyId}:${this.applicationKey}`).toString("base64");
    const body = await this.call(`${this.endpoint}/b2api/v4/b2_authorize_account`, {
      headers: { authorization: `Basic ${basic}` },
    });
    const storageApi = body?.apiInfo?.storageApi;
    if (!storageApi?.apiUrl || !storageApi?.downloadUrl || !body?.authorizationToken) {
      throw new Error("B2 b2_authorize_account returned no storage API URLs");
    }
    this.authorization = {
      accountId: body.accountId,
      token: body.authorizationToken,
      apiUrl: storageApi.apiUrl.replace(/\/+$/, ""),
      downloadUrl: storageApi.downloadUrl.replace(/\/+$/, ""),
      buckets: storageApi.allowed?.buckets || [],
    };
    this.bucketId = null;
    this.uploadTarget = null;
    return this.authorization;
  }

  /**
   * The bucket id is what every write and listing needs. A key restricted to one
   * bucket already names it; otherwise ask b2_list_buckets by name.
   */
  async resolveBucketId() {
    if (this.bucketId) return this.bucketId;
    const auth = await this.authorise();
    const named = auth.buckets.find((b) => b && b.name === this.bucketName);
    if (named?.id) {
      this.bucketId = named.id;
      return this.bucketId;
    }
    const listed = await this.call(`${auth.apiUrl}/b2api/v4/b2_list_buckets`, {
      method: "POST",
      headers: { authorization: auth.token, "content-type": "application/json" },
      body: JSON.stringify({ accountId: auth.accountId, bucketName: this.bucketName }),
    });
    const found = (listed?.buckets || []).find((b) => b && b.bucketName === this.bucketName);
    if (!found?.bucketId) {
      throw new Error(`B2 account has no bucket named "${this.bucketName}"`);
    }
    this.bucketId = found.bucketId;
    return this.bucketId;
  }

  async uploadUrl() {
    if (this.uploadTarget) return this.uploadTarget;
    const auth = await this.authorise();
    const bucketId = await this.resolveBucketId();
    const body = await this.call(
      `${auth.apiUrl}/b2api/v4/b2_get_upload_url?bucketId=${encodeURIComponent(bucketId)}`,
      { headers: { authorization: auth.token } },
    );
    if (!body?.uploadUrl || !body?.authorizationToken) {
      throw new Error("B2 b2_get_upload_url returned no uploadUrl");
    }
    this.uploadTarget = { url: body.uploadUrl, token: body.authorizationToken };
    return this.uploadTarget;
  }

  /**
   * One call with one retry. A rejected credential is answered by dropping every
   * cached one -- so the retry buys exactly one new token and one new upload URL
   * on demand, never a second round trip for each of them -- which is what the
   * documentation prescribes instead of a generic backoff loop. Anything that is
   * not a credential problem is re-thrown untouched.
   */
  async withReauth(retryable) {
    try {
      return await retryable();
    } catch (err) {
      if (!err.b2 || (err.b2.status !== 401 && err.b2.status !== 403)) throw err;
      this.authorization = null;
      this.bucketId = null;
      this.uploadTarget = null;
      return retryable();
    }
  }

  /**
   * A short-lived, bucket-scoped upload URL for one object, plus the headers to
   * send with it.
   *
   * Two things are deliberately absent from `headers`: `content-length` (the
   * browser sets it and forbids scripts from doing so) and `x-bz-content-sha1`,
   * which must describe the bytes the *client* is about to send -- this process
   * never sees them, so it cannot compute the checksum honestly. The caller adds
   * both; B2 verifies the checksum itself, and the API re-checks the stored
   * bytes before the worker ever runs.
   *
   * The token's scope is worth stating plainly: B2 has no way to restrict an
   * upload token to one name or prefix, so anyone holding it can write any
   * object in that bucket until it expires. It is therefore handed only to a
   * signed-in owner, and `docs/storage/README.md` says what else to configure.
   */
  async presign({ key, contentType }) {
    const name = this.keyFor(key);
    const type = contentType || contentTypeFor(key);
    return this.withReauth(async () => {
      const target = await this.uploadUrl();
      return {
        url: target.url,
        headers: {
          authorization: target.token,
          "x-bz-file-name": this.percentEncode(name),
          "content-type": type,
        },
      };
    });
  }

  async put(key, bytes, { contentType } = {}) {
    const name = this.keyFor(key);
    const type = contentType || contentTypeFor(key);
    const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");
    return this.withReauth(async () => {
      const target = await this.uploadUrl();
      const res = await this.fetch(target.url, {
        method: "POST",
        headers: {
          authorization: target.token,
          "x-bz-file-name": this.percentEncode(name),
          "x-bz-content-sha1": sha1,
          "content-type": type,
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      const text = await res.text();
      if (!res.ok) {
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        const err = new Error(
          `B2 upload of ${name} failed: ${(body && body.code) || res.status} ${(body && body.message) || text.slice(0, 200)}`,
        );
        err.statusCode = 502;
        err.b2 = { status: res.status, code: (body && body.code) || `http_${res.status}` };
        throw err;
      }
      return {
        key,
        bytes: bytes.length,
        contentType: type,
        sha1,
        fileId: res.headers.get("x-bz-file-id") || undefined,
      };
    });
  }

  async putFile(key, localPath, options = {}) {
    // Uploads are bounded by the API's own image/body limits, so reading the
    // file once is honest and keeps the request signed in a single pass.
    const bytes = await fsp.readFile(localPath);
    return this.put(key, bytes, { contentType: options.contentType || contentTypeFor(key) });
  }

  async head(key) {
    const found = await this.open(key, { method: "HEAD" });
    return found ? { key, length: found.length, contentType: found.contentType } : null;
  }

  async open(key, { range, method = "GET" } = {}) {
    const name = this.keyFor(key);
    // A token that expired between two requests is re-fetched once, exactly as
    // for a write; a read must not fail because it was cached overnight.
    return this.withReauth(async () => {
      const auth = await this.authorise();
      const url = `${auth.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${this.percentEncode(name)}`;
      this.requests += 1;
      const res = await this.fetch(url, {
        method,
        headers: {
          authorization: auth.token,
          ...(range ? { range } : {}),
        },
      });
      if (res.status === 404) {
        // Drain so the socket is released; B2 answers 404 for a missing file.
        await res.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`B2 download of ${name} failed: ${res.status} ${text.slice(0, 200)}`);
        err.statusCode = 502;
        err.b2 = { status: res.status };
        throw err;
      }
      const length = Number(res.headers.get("content-length") || 0);
      if (method === "HEAD") {
        await res.arrayBuffer().catch(() => undefined);
        return { key, status: res.status, length, contentType: res.headers.get("content-type") || contentTypeFor(key), stream: null };
      }
      return {
        key,
        status: res.status,
        length,
        contentType: res.headers.get("content-type") || contentTypeFor(key),
        sha1: res.headers.get("x-bz-content-sha1") || undefined,
        stream: res.body ? Readable.fromWeb(res.body) : Readable.from([]),
      };
    });
  }

  async list(prefix = CAPTURE_PREFIX) {
    const full = this.keyFor(prefix);
    return this.withReauth(async () => {
      const auth = await this.authorise();
      const bucketId = await this.resolveBucketId();
      const out = [];
      let startFileName = null;
      for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ bucketId, prefix: full });
        if (startFileName) query.set("startFileName", startFileName);
        const body = await this.call(`${auth.apiUrl}/b2api/v4/b2_list_file_names?${query}`, {
          headers: { authorization: auth.token },
        });
        for (const file of body?.files || []) {
          out.push({
            key: this.stripPrefix(file.fileName),
            length: file.contentLength,
            contentType: file.contentType || contentTypeFor(file.fileName),
            fileId: file.fileId,
          });
        }
        if (!body?.nextFileName) break;
        startFileName = body.nextFileName;
      }
      return out;
    });
  }

  stripPrefix(name) {
    const withSlash = this.prefix ? `${this.prefix.replace(/\/+$/, "")}/` : "";
    return withSlash && name.startsWith(withSlash) ? name.slice(withSlash.length) : name;
  }

  /** Delete by name; the file id is looked up when the caller has none. */
  async remove(key, { fileId } = {}) {
    const auth = await this.authorise();
    const name = this.keyFor(key);
    let id = fileId;
    if (!id) {
      const found = (await this.list(key)).find((f) => f.key === key);
      if (!found) return false;
      id = found.fileId;
    }
    await this.withReauth(async () => {
      const current = await this.authorise();
      return this.call(`${current.apiUrl}/b2api/v4/b2_delete_file_version`, {
        method: "POST",
        headers: { authorization: current.token, "content-type": "application/json" },
        body: JSON.stringify({ fileName: name, fileId: id }),
      });
    });
    return true;
  }

  /**
   * Delete every object under a key prefix (see LocalStorage.removeAll). The
   * file id returned by the listing is reused, so each deletion is one request
   * rather than a list plus a delete.
   */
  async removeAll(prefix = CAPTURE_PREFIX) {
    let removed = 0;
    for (const object of await this.list(prefix)) {
      if (await this.remove(object.key, { fileId: object.fileId })) removed += 1;
    }
    return removed;
  }
}

/**
 * Driver selection. Defaults to local disk so the product runs with no
 * credentials at all; B2 takes over the moment its three settings exist.
 * `warnings` explains a half-finished configuration instead of silently
 * pretending a bucket is in use.
 */
export function createStorage(configuration = {}) {
  const mode = String(configuration.storageDriver || "auto").toLowerCase();
  const b2 = configuration.b2 || {};
  const missing = ["keyId", "applicationKey", "bucket"].filter((k) => !b2[k]);

  if (mode === "local") {
    return new LocalStorage({ root: configuration.dataDir, prefix: "" });
  }
  if (missing.length > 0) {
    const storage = new LocalStorage({ root: configuration.dataDir, prefix: "" });
    // Only the credential fields count. `prefix` and `endpoint` have defaults
    // filled in by config.js, so treating them as "configured" would make every
    // default deployment report a warning it cannot act on (observed on the
    // running preview before this line was corrected).
    const anythingConfigured = ["keyId", "applicationKey", "bucket"].some((k) => b2[k]);
    // Nothing configured is normal and silent. Anything else is not: half a
    // configuration, or an explicit opt-in, means somebody expected a bucket and
    // would otherwise wonder why it stayed empty.
    storage.warnings =
      anythingConfigured || mode === "b2"
        ? [
            `B2 storage is incomplete (missing: ${missing.join(", ")}); captures are on local disk` +
              (mode === "b2" ? ", although STORAGE_DRIVER=b2 was asked for" : ""),
          ]
        : [];
    return storage;
  }
  return new B2Storage({
    keyId: b2.keyId,
    applicationKey: b2.applicationKey,
    bucket: b2.bucket,
    prefix: b2.prefix || "",
    endpoint: b2.endpoint,
    fetchImpl: configuration.fetchImpl,
  });
}
