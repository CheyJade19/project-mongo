// Accounts and sign-in: Sign in with Apple, Sign in with Google, or a one-time code by email.
// Each signed-in device holds a session token; households are joined through expiring invites.
import { HttpError, json, randomId, readJson, sha256 } from "./util.js";
import { LIMITS, allowed } from "./limits.js";

const SESSION_DAYS = 180;
const CODE_MINUTES = 15;
const INVITE_DAYS = 7;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to misread

const PROVIDERS = {
  google: {
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    audiences: (env) => list(env.GOOGLE_CLIENT_IDS),
  },
  apple: {
    jwks: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    audiences: (env) => list(env.APPLE_CLIENT_IDS),
  },
};
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// What the app needs to know to show the right sign-in buttons. Client ids are listed in a
// fixed order: Google is web, then iOS; Apple is the web Services ID, then the app's bundle id.
export function authConfig(env) {
  const google = list(env.GOOGLE_CLIENT_IDS), apple = list(env.APPLE_CLIENT_IDS);
  return {
    google: google.length ? { web: google[0], ios: google[1] || null } : null,
    apple: apple.length ? { web: apple[0] } : null,
    email: !!(env.RESEND_API_KEY || env.DEV_MODE === "1"),
  };
}

/* ---------- ID token verification (Apple and Google) ---------- */

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const jwksCache = new Map();

async function signingKeys(url, fetcher) {
  const hit = jwksCache.get(url);
  if (hit && hit.until > Date.now()) return hit.keys;
  const res = await fetcher(url);
  if (!res.ok) throw new HttpError(503, "Sign-in is unavailable right now. Try again in a minute.");
  const { keys } = await res.json();
  jwksCache.set(url, { keys, until: Date.now() + 60 * 60 * 1000 });
  return keys;
}

export async function verifyIdToken(provider, token, env, fetcher = fetch, now = Date.now()) {
  const p = PROVIDERS[provider];
  const audiences = p.audiences(env);
  if (!audiences.length) throw new HttpError(400, "That sign-in option isn't set up.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "Sign-in didn't go through. Try again.");
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch { throw new HttpError(401, "Sign-in didn't go through. Try again."); }
  if (header.alg !== "RS256") throw new HttpError(401, "Sign-in didn't go through. Try again.");
  const jwk = (await signingKeys(p.jwks, fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) { jwksCache.delete(p.jwks); throw new HttpError(401, "Sign-in didn't go through. Try again."); }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const nowSec = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ok || !p.issuers.includes(claims.iss) || !aud.some((a) => audiences.includes(a)) || !(claims.exp > nowSec - 60) || !claims.sub) {
    throw new HttpError(401, "Sign-in didn't go through. Try again.");
  }
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return { subject: String(claims.sub), email: verified && claims.email ? String(claims.email).toLowerCase() : null, name: claims.name ? String(claims.name) : null };
}

/* ---------- users and sessions ---------- */

async function userFor(env, provider, { subject, email, name }) {
  const found = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, subject).first();
  if (found) return found.user_id;
  // Same verified email from another provider: same person, one account.
  if (email) {
    const byEmail = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (byEmail) {
      await env.DB.prepare("INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)").bind(provider, subject, byEmail.id).run();
      return byEmail.id;
    }
  }
  const id = randomId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").bind(id, email, name ? name.slice(0, 80) : null),
    env.DB.prepare("INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)").bind(provider, subject, id),
  ]);
  return id;
}

async function startSession(env, userId) {
  const token = randomId(40);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").bind(await sha256(token), userId).run();
  return json({ session: token });
}

export async function currentUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.last_seen > datetime('now', '-${SESSION_DAYS} days')`,
  ).bind(hash).first();
  if (!row) return null;
  // Touch the session at most daily so active devices stay signed in.
  if (row.last_seen < new Date(Date.now() - 864e5).toISOString().replace("T", " ").slice(0, 19)) {
    await env.DB.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ?").bind(hash).run();
  }
  return { id: row.id, email: row.email, name: row.name, sessionHash: hash };
}

/* ---------- one-time email codes ---------- */

async function sendCode(env, email, code) {
  if (!env.RESEND_API_KEY) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Household <sign-in@household.app>",
      to: [email],
      subject: `${code} is your Household sign-in code`,
      text: `Your Household sign-in code is ${code}.\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
    }),
  });
  if (!res.ok) throw new HttpError(503, "We couldn't send the code just now. Try again in a minute.");
}

/* ---------- routes: /api/auth/*, /api/me, /api/account, /api/invites/* ---------- */

export async function authRoutes(request, env, path, ip) {
  const method = request.method;

  if (path[0] === "auth") {
    if (!(await allowed(env.AUTH_LIMIT, `auth:${ip}`))) throw new HttpError(429, "Too many tries. Wait a minute and try again.");

    if ((path[1] === "google" || path[1] === "apple") && method === "POST") {
      const body = await readJson(request);
      const identity = await verifyIdToken(path[1], body.idToken, env);
      // Apple only shares the person's name with the app, on their first sign-in.
      if (!identity.name && body.name) identity.name = String(body.name).slice(0, 80);
      return startSession(env, await userFor(env, path[1], identity));
    }

    if (path[1] === "email" && path[2] === "start" && method === "POST") {
      const email = String((await readJson(request)).email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new HttpError(400, "Check the email address and try again.");
      if (!(await allowed(env.AUTH_LIMIT, `code:${email}`))) throw new HttpError(429, "Too many codes requested. Wait a minute and try again.");
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      await env.DB.prepare(
        `INSERT INTO email_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, datetime('now', '+${CODE_MINUTES} minutes'), 0)
         ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      ).bind(email, await sha256(`${email}:${code}`)).run();
      await sendCode(env, email, code);
      // Local development only: without an email service the code comes back in the response.
      return json(env.DEV_MODE === "1" && !env.RESEND_API_KEY ? { sent: true, devCode: code } : { sent: true });
    }

    if (path[1] === "email" && path[2] === "verify" && method === "POST") {
      const body = await readJson(request);
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").replace(/\D/g, "");
      const row = await env.DB.prepare("SELECT code_hash, attempts, expires_at > datetime('now') AS live FROM email_codes WHERE email = ?").bind(email).first();
      if (!row || !row.live || row.attempts >= 5) throw new HttpError(401, "That code has expired. Ask for a new one.");
      if (row.code_hash !== (await sha256(`${email}:${code}`))) {
        await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
        throw new HttpError(401, "That code isn't right. Check it and try again.");
      }
      await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
      return startSession(env, await userFor(env, "email", { subject: email, email, name: null }));
    }
    throw new HttpError(404, "Not found");
  }

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in again.");

  if (path[0] === "signout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.sessionHash).run();
    return json({ ok: true });
  }

  if (path[0] === "me" && method === "GET") {
    const hh = await env.DB.prepare(
      "SELECT h.id, h.name, m.role FROM memberships m JOIN households h ON h.id = m.household_id WHERE m.user_id = ? ORDER BY m.joined_at",
    ).bind(user.id).all();
    const ids = await env.DB.prepare("SELECT DISTINCT provider FROM identities WHERE user_id = ?").bind(user.id).all();
    return json({ user: { id: user.id, email: user.email, name: user.name, providers: ids.results.map((r) => r.provider) }, households: hh.results });
  }

  if (path[0] === "me" && method === "PATCH") {
    const name = String((await readJson(request)).name || "").trim().slice(0, 80) || null;
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
    return json({ ok: true });
  }

  // Delete the account: sign-ins, sessions and memberships. A household nobody else uses is
  // deleted with everything in it; a shared one is handed to the longest-standing member.
  if (path[0] === "account" && method === "DELETE") {
    const mine = await env.DB.prepare("SELECT household_id, role FROM memberships WHERE user_id = ?").bind(user.id).all();
    for (const m of mine.results) {
      const others = await env.DB.prepare("SELECT user_id FROM memberships WHERE household_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1").bind(m.household_id, user.id).first();
      if (!others) await deleteHousehold(env, m.household_id);
      else if (m.role === "owner") await env.DB.prepare("UPDATE memberships SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(m.household_id, others.user_id).run();
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM identities WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(user.email || ""),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return json({ ok: true });
  }

  if (path[0] === "invites" && path[1] === "accept" && method === "POST") {
    if (!(await allowed(env.AUTH_LIMIT, `invite:${user.id}`))) throw new HttpError(429, "Too many tries. Wait a minute and try again.");
    const code = normaliseInvite((await readJson(request)).code);
    const inv = await env.DB.prepare(
      "SELECT i.household_id, h.name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.code = ? AND i.expires_at > datetime('now') AND i.uses_left > 0",
    ).bind(code).first();
    if (!inv) throw new HttpError(404, "That invite has expired or been used up. Ask for a new one.");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?").bind(user.id).first();
    const already = await env.DB.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND household_id = ?").bind(user.id, inv.household_id).first();
    if (!already) {
      if (count.n >= LIMITS.householdsPerUser) throw new HttpError(403, `You can be in up to ${LIMITS.householdsPerUser} households.`);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO memberships (user_id, household_id, role) VALUES (?, ?, 'member')").bind(user.id, inv.household_id),
        env.DB.prepare("UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?").bind(code),
      ]);
    }
    return json({ household: { id: inv.household_id, name: inv.name } });
  }

  return null; // not an account route; the household API handles it
}

export const normaliseInvite = (c) => String(c || "").toUpperCase().replace(/^.*[?&]INVITE=/, "").replace(/[^A-Z0-9]/g, "").slice(0, 12);

export async function createInvite(env, householdId, userId) {
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE household_id = ? AND expires_at > datetime('now') AND uses_left > 0").bind(householdId).first();
  if (open.n >= LIMITS.invitesOpenPerHousehold) throw new HttpError(403, "There are already plenty of open invites. Use one of those, or wait for them to expire.");
  const code = randomId(8, INVITE_ALPHABET);
  await env.DB.prepare(
    `INSERT INTO invites (code, household_id, created_by, expires_at, uses_left) VALUES (?, ?, ?, datetime('now', '+${INVITE_DAYS} days'), 10)`,
  ).bind(code, householdId, userId).run();
  const row = await env.DB.prepare("SELECT expires_at FROM invites WHERE code = ?").bind(code).first();
  return { code, expiresAt: row.expires_at };
}

export async function deleteHousehold(env, householdId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM items WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM inboxes WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM inbound WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM invites WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM photos WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM memberships WHERE household_id = ?").bind(householdId),
    env.DB.prepare("DELETE FROM households WHERE id = ?").bind(householdId),
  ]);
}
