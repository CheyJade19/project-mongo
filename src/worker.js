// Household Calendar: serves the app (from /public), a small JSON API under /api,
// and receives the emails people choose to forward to their private address.
// Forwarded emails wait in that person's "To review" list; nothing reaches the calendar
// until they pick what to add, and the email's text is deleted once they have.
import PostalMime from "postal-mime";
import { parseICS } from "./ics.js";
import { htmlToText } from "./text.js";
import "../public/dates.js";

const { findDates } = globalThis.HouseholdDates;
const KEEP_PENDING_DAYS = 14;

const COLS = new Set(["members", "events", "todos"]);
const MAX_DOC = 64 * 1024;
const MAX_EMAIL = 10 * 1024 * 1024;

// The iOS and Android apps call the API from their own origin; auth is a bearer key, not cookies.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const fail = (status, error) => json({ error }, status);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomId(length = 16) {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => ALPHABET[b % 36]).join("");
}
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const slug = (s) => (s || "me").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16) || "me";
const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

async function household(request, env) {
  const auth = request.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return null;
  return env.DB.prepare("SELECT id, name, tz FROM households WHERE key_hash = ?").bind(await sha256(key)).first();
}

function inboxAddress(env, member, token) {
  return env.EMAIL_DOMAIN && token ? `${slug(member.name)}.${token}@${env.EMAIL_DOMAIN}` : null;
}

async function ensureInbox(env, hid, memberId) {
  const row = await env.DB.prepare("SELECT token FROM inboxes WHERE household_id = ? AND member_id = ?").bind(hid, memberId).first();
  if (row) return row.token;
  const token = randomId(12);
  await env.DB.prepare("INSERT INTO inboxes (token, household_id, member_id) VALUES (?, ?, ?)").bind(token, hid, memberId).run();
  return token;
}

async function loadState(env, h) {
  await env.DB.prepare(
    `UPDATE inbound SET status = 'expired', payload = NULL WHERE household_id = ? AND status = 'pending' AND received_at < datetime('now', '-${KEEP_PENDING_DAYS} days')`,
  ).bind(h.id).run();
  const [items, inboxes, inbound] = await Promise.all([
    env.DB.prepare("SELECT col, id, data FROM items WHERE household_id = ?").bind(h.id).all(),
    env.DB.prepare("SELECT token, member_id FROM inboxes WHERE household_id = ?").bind(h.id).all(),
    env.DB.prepare("SELECT id, member_id, from_addr, subject, received_at, status, event_count, payload FROM inbound WHERE household_id = ? ORDER BY received_at DESC LIMIT 40").bind(h.id).all(),
  ]);
  const state = { members: [], events: [], todos: [] };
  for (const r of items.results) state[r.col].push({ ...JSON.parse(r.data), id: r.id });
  const tokens = Object.fromEntries(inboxes.results.map((r) => [r.member_id, r.token]));
  state.members = state.members.map((m) => ({ ...m, inbox: inboxAddress(env, m, tokens[m.id]) }));
  const inboundRows = inbound.results.map(({ payload, ...r }) => ({ ...r, ...(payload ? JSON.parse(payload) : {}) }));
  return { household: { name: h.name, tz: h.tz, emailEnabled: !!env.EMAIL_DOMAIN }, ...state, inbound: inboundRows };
}

async function putItem(env, hid, col, id, data) {
  const { id: _drop, inbox: _inbox, ...body } = data;
  const text = JSON.stringify(body);
  if (text.length > MAX_DOC) throw new Error("too_large");
  await env.DB.prepare(
    "INSERT INTO items (household_id, col, id, data, updated_at) VALUES (?, ?, ?, ?, datetime('now')) " +
    "ON CONFLICT (household_id, col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ).bind(hid, col, id, text).run();
}

async function addEvents(env, hid, memberIds, events, extra) {
  const existing = await env.DB.prepare("SELECT data FROM items WHERE household_id = ? AND col = 'events'").bind(hid).all();
  const seen = new Set();
  for (const r of existing.results) {
    const e = JSON.parse(r.data);
    if (e.uid) seen.add("uid:" + e.uid);
    seen.add(`k:${(e.title || "").toLowerCase()}|${e.date}|${e.start || ""}`);
  }
  let added = 0;
  for (const e of events) {
    const k = `k:${e.title.toLowerCase()}|${e.date}|${e.start || ""}`;
    if ((e.uid && seen.has("uid:" + e.uid)) || seen.has(k)) continue;
    seen.add(k);
    await putItem(env, hid, "events", randomId(), { ...e, memberIds, source: "email", ...extra });
    added++;
  }
  return added;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/, HHMM = /^\d{2}:\d{2}$/;
function cleanEvent(e) {
  if (!e || !DATE.test(e.date || "")) return null;
  const start = HHMM.test(e.start || "") ? e.start : null;
  return {
    title: String(e.title || "Untitled").slice(0, 120),
    date: e.date,
    allDay: !start,
    start,
    end: start && HHMM.test(e.end || "") ? e.end : null,
    location: e.location ? String(e.location).slice(0, 160) : null,
    uid: e.uid ? String(e.uid).slice(0, 300) : null,
  };
}

async function api(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;

  if (path[0] === "households" && method === "POST" && path.length === 1) {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "Our household").slice(0, 60);
    const tz = validTz(body.tz) ? body.tz : "UTC";
    const id = randomId(), key = randomId(32);
    await env.DB.prepare("INSERT INTO households (id, name, key_hash, tz) VALUES (?, ?, ?, ?)").bind(id, name, await sha256(key), tz).run();
    return json({ key });
  }

  const h = await household(request, env);
  if (!h) return fail(401, "This device isn't part of a household yet. Open your invite link again.");

  if (path[0] === "state" && method === "GET") return json(await loadState(env, h));

  if (path[0] === "household" && method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const name = body.name ? String(body.name).slice(0, 60) : h.name;
    const tz = validTz(body.tz) ? body.tz : h.tz;
    await env.DB.prepare("UPDATE households SET name = ?, tz = ? WHERE id = ?").bind(name, tz, h.id).run();
    return json({ ok: true });
  }

  // A person reviews one forwarded email: add the events they picked, or dismiss it.
  // Either way the email's text is deleted from the server.
  if (path[0] === "inbound" && path[1]) {
    const row = await env.DB.prepare("SELECT id, member_id, subject, status FROM inbound WHERE id = ? AND household_id = ?").bind(path[1], h.id).first();
    if (!row) return fail(404, "That email is no longer here.");
    if (method === "POST" && path[2] === "accept") {
      const body = await request.json().catch(() => ({}));
      const memberIds = Array.isArray(body.memberIds) && body.memberIds.length ? body.memberIds.map(String).slice(0, 20) : [row.member_id];
      const events = (Array.isArray(body.events) ? body.events : []).slice(0, 50).map(cleanEvent).filter(Boolean);
      if (!events.length) return fail(400, "Pick at least one event to add.");
      const added = await addEvents(env, h.id, memberIds, events, { emailSubject: (row.subject || "").slice(0, 200) });
      await env.DB.prepare("UPDATE inbound SET status = 'added', event_count = ?, payload = NULL WHERE id = ?").bind(added, row.id).run();
      return json({ added });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE inbound SET status = 'dismissed', payload = NULL WHERE id = ?").bind(row.id).run();
      return json({ ok: true });
    }
    return fail(405, "Not allowed");
  }

  const [col, id] = path;
  if (!COLS.has(col)) return fail(404, "Not found");

  if (method === "POST" && !id) {
    const body = await request.json();
    const newId = randomId();
    await putItem(env, h.id, col, newId, body);
    if (col === "members") await ensureInbox(env, h.id, newId);
    return json({ id: newId });
  }
  if (method === "PUT" && id) {
    await putItem(env, h.id, col, id, await request.json());
    if (col === "members") await ensureInbox(env, h.id, id);
    return json({ ok: true });
  }
  if (method === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM items WHERE household_id = ? AND col = ? AND id = ?").bind(h.id, col, id).run();
    if (col === "members") await env.DB.prepare("DELETE FROM inboxes WHERE household_id = ? AND member_id = ?").bind(h.id, id).run();
    return json({ ok: true });
  }
  return fail(405, "Not allowed");
}

const decode = (content) => (typeof content === "string" ? content : new TextDecoder().decode(content));

async function receiveEmail(message, env) {
  // <name>.<token>@EMAIL_DOMAIN: the token after the last dot picks the person.
  const local = message.to.split("@")[0].toLowerCase();
  const token = local.includes(".") ? local.slice(local.lastIndexOf(".") + 1) : local;
  const inbox = await env.DB.prepare(
    "SELECT i.household_id, i.member_id, h.tz FROM inboxes i JOIN households h ON h.id = i.household_id WHERE i.token = ?",
  ).bind(token).first();
  if (!inbox) { message.setReject("Unknown address"); return; }
  const save = (status, mail, payload) =>
    env.DB.prepare("INSERT INTO inbound (id, household_id, member_id, from_addr, subject, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId(), inbox.household_id, inbox.member_id, (mail?.from?.address || message.from || "").slice(0, 200),
        (mail?.subject || "").slice(0, 200), status, payload ? JSON.stringify(payload) : null).run();

  if (message.rawSize > MAX_EMAIL) { await save("too_large", null, null); return; }
  const mail = await PostalMime.parse(message.raw);
  // Keep only what the person needs to choose events: invites, the dates written in the email,
  // and a short excerpt to recognise it by. It waits for them in the app.
  const invites = (mail.attachments || [])
    .filter((a) => /calendar|\.ics$/i.test(a.mimeType + " " + (a.filename || "")))
    .flatMap((a) => parseICS(decode(a.content), inbox.tz))
    .slice(0, 50);
  const text = (mail.text || htmlToText(mail.html || "")).slice(0, 20000);
  const sent = mail.date ? new Date(mail.date) : new Date();
  const dates = invites.length ? [] : findDates(`${mail.subject || ""}\n${text}`, { ref: isNaN(sent) ? new Date() : sent });
  await save("pending", mail, { invites, dates, excerpt: text.slice(0, 1500) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      try { return await api(request, env, url); }
      catch (e) { return fail(e?.message === "too_large" ? 413 : 500, e?.message === "too_large" ? "That's too large to save." : "Something went wrong. Try again."); }
    }
    return env.ASSETS.fetch(request);
  },
  async email(message, env) {
    await receiveEmail(message, env);
  },
};
