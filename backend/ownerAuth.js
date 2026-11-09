// Owner login for the order dashboard. One owner account, set with: npm run set-owner-password
// The password is stored only as a scrypt hash in .env (OWNER_PASSWORD_HASH). Sessions live in memory,
// so the owner logs in again after a server restart.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "t2co_owner";
const COOKIE_PATH = "/owner";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Stored as scrypt:N:r:p:salt:hash (hex), so it is safe to put in .env.
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("hex"), hash.toString("hex")].join(":");
}

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
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
  // A password typed into .env by hand (instead of the hash from set-owner-password) can never match.
  const configured = Boolean(env.OWNER_USERNAME && env.OWNER_PASSWORD_HASH?.startsWith("scrypt:"));

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
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
  }

  function sessionToken(req) {
    const token = readCookie(req, COOKIE);
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

    // Returns null on success, or an error message.
    login(req, res, { username, password } = {}) {
      const now = Date.now();
      if (!configured) return "Owner login is not set up yet. In the backend folder, run: npm.cmd run set-owner-password";
      if (isLockedOut(req.ip, now)) return "Too many failed attempts. Please wait 15 minutes and try again.";
      const valid =
        typeof username === "string" &&
        typeof password === "string" &&
        password.length <= 200 &&
        sameText(username.trim(), env.OWNER_USERNAME) &&
        verifyPassword(password, env.OWNER_PASSWORD_HASH);
      if (!valid) {
        recordFailure(req.ip, now);
        return "Wrong username or password.";
      }
      failures.delete(req.ip);
      for (const [token, expiresAt] of sessions) if (expiresAt < now) sessions.delete(token);
      const token = randomBytes(32).toString("hex");
      sessions.set(token, now + SESSION_MS);
      setCookie(req, res, token, SESSION_MS / 1000);
      return null;
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
