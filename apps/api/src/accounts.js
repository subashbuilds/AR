// Accounts, sessions and share tokens.
//
// First-party on purpose. There is no third-party identity service here: an
// email and a password are hashed with scrypt (node:crypto) and an opaque
// session token is stored as a SHA-256 digest in the same SQLite engine the
// capture store uses. Nothing about a user leaves this host, and there is no
// npm dependency to keep current.
//
// Two rules this file exists to enforce:
//
//   * A password is never stored, logged or returned. Only the scrypt hash.
//   * A sign-in failure never says WHICH half was wrong, and it still runs a
//     scrypt comparison when the address is unknown, so the response time does
//     not reveal whether an account exists.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Sessions last 30 days; `expires_at` is enforced on every lookup. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** scrypt cost. 128 * N * r = 16 MiB per hash, inside node's default maxmem. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Long enough to be worth typing, short enough to allow a passphrase. */
export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

/** An email shape check, not a deliverability check — nothing is sent. */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  let actual;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash of a password nobody knows, so an unknown email costs the same time. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString("hex"));

export function normaliseEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw bad("enter a valid email address");
  }
  return email;
}

export function checkPassword(input) {
  const password = String(input ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw bad(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw bad(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return password;
}

/** Opaque, URL-safe, 192 bits. Used for share links. */
export function newShareToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function digest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
}

export class Accounts {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "accounts.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Create a user. Duplicate addresses are refused, not silently merged. */
  signUp({ email, password, name }) {
    const address = normaliseEmail(email);
    const secret = checkPassword(password);
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(address);
    if (existing) throw bad("an account with that email already exists", 409);
    const id = crypto.randomUUID();
    const cleanName = String(name || "").trim().slice(0, 120) || null;
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, address, cleanName, hashPassword(secret), Date.now());
    return publicUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  /**
   * Verify an email/password pair. Returns the user or null. The failure is
   * deliberately indistinguishable from a wrong password (same message, same
   * cost) so the endpoint cannot be used to enumerate accounts.
   */
  signIn({ email, password }) {
    let address = null;
    try {
      address = normaliseEmail(email);
    } catch {
      address = null;
    }
    const row = address
      ? this.db.prepare("SELECT * FROM users WHERE email = ?").get(address)
      : null;
    const secret = String(password ?? "");
    const ok = verifyPassword(secret, row ? row.password_hash : DUMMY_HASH);
    return row && ok ? publicUser(row) : null;
  }

  /** Open a session and return the raw token. Only its digest is stored. */
  startSession(userId, { now = Date.now() } = {}) {
    const token = crypto.randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(digest(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  /** Resolve a raw token to its user, or null if unknown or expired. */
  userForToken(token, { now = Date.now() } = {}) {
    if (!token || typeof token !== "string" || token.length > 200) return null;
    const key = digest(token);
    const session = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(key);
    if (!session) return null;
    if (session.expires_at <= now) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(key);
      return null;
    }
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
    return row ? publicUser(row) : null;
  }

  /** Sign out. Returns true when a session was actually revoked. */
  endSession(token) {
    if (!token) return false;
    const res = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
    return res.changes > 0;
  }

  /**
   * True when `password` is this account's password. Used as confirmation
   * before destroying data. A missing row still pays the scrypt cost, so the
   * check cannot be timed to discover whether an account exists.
   */
  verifyUserPassword(userId, password) {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    const ok = verifyPassword(String(password ?? ""), row ? row.password_hash : DUMMY_HASH);
    return Boolean(row) && ok;
  }

  /**
   * Remove an account and every session it holds. Returns how many of each were
   * dropped. The captures and their objects are removed by the caller -- this
   * layer does not know where a capture's bytes live.
   */
  deleteUser(userId) {
    const sessions = this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
    const users = this.db.prepare("DELETE FROM users WHERE id = ?").run(userId).changes;
    return { users, sessions };
  }

  /** Test/ops helper: how many live sessions this user has. */
  sessionCount(userId, { now = Date.now() } = {}) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?")
      .get(userId, now);
    return row ? row.n : 0;
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Session cookie. HttpOnly (no script can read it), SameSite=Lax (a cross-site
 * POST cannot ride on it), Path=/, and Secure whenever the request arrived over
 * TLS — including through the platform's proxy, which sets x-forwarded-proto.
 */
export const SESSION_COOKIE = "oca_session";

export function readSessionToken(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(idx + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

export function sessionCookie(token, { secure, maxAgeSeconds = SESSION_TTL_MS / 1000 } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearedCookie({ secure } = {}) {
  const bits = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/** Trusted only because the platform proxy terminates TLS in front of us. */
export function isSecureRequest(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return Boolean(req.socket?.encrypted);
}
