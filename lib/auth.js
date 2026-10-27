import crypto from "node:crypto";

// AUTH_USERS = JSON: [{"id":"pawel","name":"Paweł","hash":"scrypt$<salt>$<hash>"}]
export function users() {
  try {
    return JSON.parse(process.env.AUTH_USERS || "[]");
  } catch {
    return [];
  }
}

export function publicUsers() {
  return users().map((u) => ({ id: u.id, name: u.name }));
}

export function checkPassword(userId, password) {
  const u = users().find((x) => x.id === userId);
  if (!u || !password) return null;
  const [, salt, hash] = String(u.hash).split("$");
  const calc = crypto.scryptSync(password, Buffer.from(salt, "hex"), 32);
  const ok = crypto.timingSafeEqual(calc, Buffer.from(hash, "hex"));
  return ok ? { id: u.id, name: u.name } : null;
}

const COOKIE = "ms_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 dni

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET missing");
  return s;
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function signSession(user) {
  const payload = b64(JSON.stringify({ u: user.id, n: user.name, exp: Date.now() + MAX_AGE * 1000 }));
  const sig = b64(crypto.createHmac("sha256", secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const good = b64(crypto.createHmac("sha256", secret()).update(payload).digest());
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp < Date.now()) return null;
    return { id: data.u, name: data.n };
  } catch {
    return null;
  }
}

export const sessionCookie = { name: COOKIE, maxAge: MAX_AGE };

export function userFromRequest(request) {
  return verifySession(request.cookies.get(COOKIE)?.value);
}
