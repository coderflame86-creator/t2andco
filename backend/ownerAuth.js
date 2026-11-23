// Owner login for the order dashboard. Supports multiple owner accounts in .env:
// OWNER_USERNAME / OWNER_PASSWORD_HASH and OWNER2_USERNAME / OWNER2_PASSWORD_HASH
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "t2co_owner";
const COOKIE_PATH = "/";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Stored as scrypt:N:r:p:salt:hash (hex), so it is safe to put in .env.
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("hex"), hash.toString("hex")].join(":");
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  if (stored.startsWith("scrypt:")) {
    const [kind, N, r, p, salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return timingSafeEqual(actual, expected);
  }
  if (stored.startsWith("sha256:")) {
    const [kind, salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = createHash("sha256").update(salt + password).digest();
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }
  return false;
}

function getOwnerAccounts(env) {
  const accounts = [];
  if (env.OWNER_USERNAME && env.OWNER_PASSWORD_HASH) {
    accounts.push({ username: env.OWNER_USERNAME, hash: env.OWNER_PASSWORD_HASH });
  }
  if (env.OWNER2_USERNAME && env.OWNER2_PASSWORD_HASH) {
    accounts.push({ username: env.OWNER2_USERNAME, hash: env.OWNER2_PASSWORD_HASH });
  }
  for (let i = 3; i <= 10; i++) {
    if (env[`OWNER${i}_USERNAME`] && env[`OWNER${i}_PASSWORD_HASH`]) {
      accounts.push({ username: env[`OWNER${i}_USERNAME`], hash: env[`OWNER${i}_PASSWORD_HASH`] });
    }
  }
  return accounts;
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(req, name) {
  const pair = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

export function createOwnerAuth(env) {
  const sessions = new Map(); // token -> expiresAt
  const failures = new Map(); // ip -> { count, since }
  const accounts = getOwnerAccounts(env);
  const configured = accounts.length > 0;

  function isLockedOut(ip, now) {
    const entry = failures.get(ip);
    if (!entry || now - entry.since > LOCKOUT_MS) return false;
    return entry.count >= MAX_FAILED_LOGINS;
  }

  function recordFailure(ip, now) {
    const entry = failures.get(ip);
    if (!entry || now - entry.since > LOCKOUT_MS) failures.set(ip, { count: 1, since: now });
    else entry.count++;
  }

  function setCookie(req, res, token, maxAgeSeconds) {
    const secure = req.secure ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
  }

  function sessionToken(req) {
    const authHeader = req.headers?.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    }
    if (!token) {
      token = readCookie(req, COOKIE);
    }
    const expiresAt = token && sessions.get(token);
    if (!expiresAt) return null;
    if (expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return token;
  }

  return {
    configured,

    // Returns null on success (or { error: null, token }), or an error message.
    login(req, res, { username, password } = {}) {
      const now = Date.now();
      if (!configured) return { error: "Owner login is not set up yet. In the backend folder, run: npm.cmd run set-owner-password" };
      if (isLockedOut(req.ip, now)) return { error: "Too many failed attempts. Please wait 15 minutes and try again." };
      const currentAccounts = getOwnerAccounts(env);
      const account = currentAccounts.find((a) => typeof username === "string" && sameText(username.trim(), a.username));
      const valid =
        Boolean(account) &&
        typeof password === "string" &&
        password.length <= 200 &&
        verifyPassword(password, account.hash);
      if (!valid) {
        recordFailure(req.ip, now);
        return { error: "Wrong username or password." };
      }
      failures.delete(req.ip);
      for (const [t, expiresAt] of sessions) if (expiresAt < now) sessions.delete(t);
      const token = randomBytes(32).toString("hex");
      sessions.set(token, now + SESSION_MS);
      setCookie(req, res, token, SESSION_MS / 1000);
      return { error: null, token };
    },

    logout(req, res) {
      const token = sessionToken(req);
      if (token) sessions.delete(token);
      setCookie(req, res, "", 0);
    },

    isLoggedIn(req) {
      return Boolean(sessionToken(req));
    },

    requireOwner(req, res, next) {
      if (!sessionToken(req)) return res.status(401).json({ error: "Please log in." });
      next();
    },
  };
}
