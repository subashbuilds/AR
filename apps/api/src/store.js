// Capture state store.
//
// Uses node:sqlite (built into Node 22.5+, unflagged from 22.13) so the service
// has zero npm dependencies. Every row is one capture: its uploaded photos, the
// job contract written for the worker, the worker's own progress log and the
// final manifest.
//
// Two of the columns are about access, not reconstruction: `user_id` is the
// account that owns the capture, and `share_token` is the *only* thing that
// lets a second device read it. A capture with no share_token is private to its
// owner even to someone holding the exact URL.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,
  stage          TEXT,
  note           TEXT,
  progress       REAL,
  stage_progress REAL,
  progress_source TEXT,
  elapsed_seconds REAL,
  eta_seconds    REAL,
  image_count    INTEGER NOT NULL,
  calibration    TEXT,
  worker_code    INTEGER,
  error          TEXT,
  result         TEXT,
  dir            TEXT NOT NULL,
  user_id        TEXT,
  share_token    TEXT,
  pending_uploads TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
`;

/** Columns added after the first release, for databases that already exist. */
const ADDED_COLUMNS = [
  ["user_id", "TEXT"],
  ["share_token", "TEXT"],
  ["pending_uploads", "TEXT"],
];

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "captures.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * CREATE TABLE IF NOT EXISTS cannot add a column to an existing database, so
   * an older captures.db is upgraded in place rather than discarded. Rows that
   * predate accounts keep `user_id = NULL` and are visible to nobody until an
   * owner claims them.
   */
  migrate() {
    const have = new Set(
      this.db.prepare("PRAGMA table_info(captures)").all().map((c) => c.name),
    );
    for (const [name, type] of ADDED_COLUMNS) {
      if (have.has(name)) continue;
      this.db.exec(`ALTER TABLE captures ADD COLUMN ${name} ${type}`);
    }
  }

  /** The UUID of a capture's share link, or null when it is not shared. */
  shareToken(id) {
    const row = this.db.prepare("SELECT share_token FROM captures WHERE id = ?").get(id);
    return row ? row.share_token : null;
  }

  /** Turn sharing on with a fresh token, or off by passing null. */
  setShareToken(id, token) {
    this.db
      .prepare("UPDATE captures SET share_token = ?, updated_at = ? WHERE id = ?")
      .run(token, Date.now(), id);
    return token;
  }

  captureDir(id) {
    return path.join(this.dataDir, "captures", id);
  }

  /**
   * A capture starts in one of two ways. `queued` is the request-body path:
   * the photographs are already on disk, so a worker slot is all that is
   * missing. `uploading` is the direct-to-store path: the row exists so the
   * upload has somewhere to land, but there are no bytes here yet -- and the
   * job runner must never pick it up, because `run()` would find no images.
   */
  create({
    id,
    name,
    imageCount,
    calibration,
    dir,
    userId = null,
    status = "queued",
    note = null,
    pendingUploads = null,
  }) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO captures (id, name, status, stage, note, progress, image_count,
                               calibration, dir, user_id, pending_uploads,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        status,
        status,
        note ?? (status === "uploading"
          ? "waiting for the photographs to be uploaded"
          : "waiting for a worker slot"),
        imageCount,
        calibration ? JSON.stringify(calibration) : null,
        dir,
        userId,
        pendingUploads ? JSON.stringify(pendingUploads) : null,
        now,
        now,
      );
  }

  /** The upload manifest a direct upload is expected to deliver, if any. */
  pendingUploads(id) {
    const row = this.db.prepare("SELECT pending_uploads FROM captures WHERE id = ?").get(id);
    if (!row || !row.pending_uploads) return null;
    try {
      const parsed = JSON.parse(row.pending_uploads);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  setPendingUploads(id, uploads) {
    return this.db
      .prepare("UPDATE captures SET pending_uploads = ?, updated_at = ? WHERE id = ?")
      .run(uploads ? JSON.stringify(uploads) : null, Date.now(), id).changes;
  }

  /**
   * Captures whose direct upload never finished. They describe work nobody will
   * ever complete, so retention may remove them without asking anyone.
   */
  abandonedUploads(before, limit = 500) {
    return this.db
      .prepare(
        "SELECT * FROM captures WHERE status = 'uploading' AND updated_at < ? " +
          "ORDER BY updated_at ASC LIMIT ?",
      )
      .all(before, limit)
      .map(hydrate);
  }

  /**
   * Captures older than a cut-off, for a time-based retention policy. This is
   * only called when a non-zero TTL is configured; the default is to keep a
   * capture until its owner deletes it.
   */
  createdBefore(cutoff, limit = 500) {
    return this.db
      .prepare("SELECT * FROM captures WHERE created_at < ? ORDER BY created_at ASC LIMIT ?")
      .all(cutoff, limit)
      .map(hydrate);
  }

  update(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    for (const k of keys) {
      if (fields[k] === undefined) {
        throw new TypeError(`store.update: "${k}" is undefined; use null to clear a column`);
      }
    }
    const sql = `UPDATE captures SET ${keys.map((k) => `${k} = ?`).join(", ")},
                 updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k]), Date.now(), id);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM captures WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
  }

  /**
   * Captures are always listed for exactly one owner. There is no "all
   * captures" listing: an unscoped list is what let every visitor see every
   * reconstruction.
   *
   * An `uploading` row is excluded: until its photographs land it is not a
   * capture, and showing one would put a reconstruction that cannot exist in
   * somebody's list. It is still deletable with the account (allForUser does not
   * filter) and the retention sweep removes an abandoned one.
   */
  list(userId, limit = 50) {
    return this.db
      .prepare(
        "SELECT * FROM captures WHERE user_id = ? AND status != 'uploading' " +
          "ORDER BY created_at DESC LIMIT ?",
      )
      .all(userId, limit)
      .map(hydrate);
  }

  /**
   * Every capture this account owns, for account deletion. Unlike `list` this
   * is not capped: deleting an account must not leave rows (or their objects)
   * behind because the owner had more than one page of captures.
   */
  allForUser(userId) {
    return this.db
      .prepare("SELECT * FROM captures WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId)
      .map(hydrate);
  }

  /**
   * Captures that were not in a terminal state when the process stopped. The job
   * queue lives in memory, so these are exactly the rows a restart has
   * forgotten: they would otherwise read as "in progress" for ever.
   */
  unfinished() {
    return this.db
      .prepare("SELECT * FROM captures WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all()
      .map(hydrate);
  }

  /** Drop a capture's row. Its bytes are the caller's job (see storage.removeAll). */
  remove(id) {
    return this.db.prepare("DELETE FROM captures WHERE id = ?").run(id).changes > 0;
  }
}

function hydrate(row) {
  const parse = (v) => {
    if (v === null || v === undefined) return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    stage: row.stage,
    note: row.note,
    progress: row.progress,
    stageProgress: row.stage_progress,
    progressSource: row.progress_source,
    elapsedSeconds: row.elapsed_seconds,
    etaSeconds: row.eta_seconds,
    imageCount: row.image_count,
    calibration: parse(row.calibration),
    workerCode: row.worker_code,
    error: parse(row.error),
    result: parse(row.result),
    dir: row.dir,
    userId: row.user_id,
    shareToken: row.share_token,
    pendingUploads: parse(row.pending_uploads),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}