// Household Calendar: serves the app (from /public), a small JSON API under /api,
// and receives forwarded email for each person's private address.
import PostalMime from "postal-mime";
import { parseICS } from "./ics.js";
import { extractEvents, htmlToText } from "./extract.js";

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
  const [items, inboxes, inbound] = await Promise.all([
    env.DB.prepare("SELECT col, id, data FROM items WHERE household_id = ?").bind(h.id).all(),
    env.DB.prepare("SELECT token, member_id FROM inboxes WHERE household_id = ?").bind(h.id).all(),
    env.DB.prepare("SELECT id, member_id, from_addr, subject, received_at, status, event_count, detail FROM inbound WHERE household_id = ? ORDER BY received_at DESC LIMIT 30").bind(h.id).all(),
  ]);
  const state = { members: [], events: [], todos: [] };
  for (const r of items.results) state[r.col].push({ ...JSON.parse(r.data), id: r.id });
  const tokens = Object.fromEntries(inboxes.results.map((r) => [r.member_id, r.token]));
  state.members = state.members.map((m) => ({ ...m, inbox: inboxAddress(env, m, tokens[m.id]) }));
  return { household: { name: h.name, tz: h.tz, emailEnabled: !!env.EMAIL_DOMAIN, claudeEnabled: !!env.ANTHROPIC_API_KEY }, ...state, inbound: inbound.results };
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

async function addEvents(env, hid, memberId, events, extra) {
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
    await putItem(env, hid, "events", randomId(), { ...e, memberIds: [memberId], source: "email", ...extra });
    added++;
  }
  return added;
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

  // Paste or upload an email in the app: find events but don't save them; the person picks.
  if (path[0] === "extract" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const raw = String(body.text || "");
    if (!raw.trim()) return fail(400, "Paste an email first.");
    if (/BEGIN:VEVENT/.test(raw)) return json({ events: parseICS(raw, h.tz) });
    let subject = "", from = "", sentAt = "", text = raw;
    if (/^(received|from|subject|date|mime-version|return-path):/im.test(raw.slice(0, 2000)) && /\n\r?\n/.test(raw)) {
      try {
        const mail = await PostalMime.parse(raw);
        subject = mail.subject || ""; from = mail.from?.address || ""; sentAt = mail.date || "";
        const ics = (mail.attachments || []).filter((a) => /calendar|\.ics$/i.test(a.mimeType + " " + (a.filename || "")));
        if (ics.length) return json({ events: ics.flatMap((a) => parseICS(decode(a.content), h.tz)) });
        text = mail.text || htmlToText(mail.html || "") || raw;
      } catch { /* treat as plain text */ }
    }
    if (!env.ANTHROPIC_API_KEY) return fail(503, "Reading ordinary emails isn't switched on yet. Calendar invites (.ics) still work.");
    const r = await extractEvents(env, { subject, from, sentAt, text, timeZone: h.tz });
    return json({ events: r.events });
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
  const log = async (status, count, detail, mail) =>
    env.DB.prepare("INSERT INTO inbound (id, household_id, member_id, from_addr, subject, status, event_count, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId(), inbox.household_id, inbox.member_id, mail?.from?.address || message.from, (mail?.subject || "").slice(0, 200), status, count, detail || null).run();

  if (message.rawSize > MAX_EMAIL) { await log("too_large", 0, "Email was larger than 10 MB"); return; }
  const mail = await PostalMime.parse(message.raw);
  try {
    const ics = (mail.attachments || []).filter((a) => /calendar|\.ics$/i.test(a.mimeType + " " + (a.filename || "")));
    let events = ics.flatMap((a) => parseICS(decode(a.content), inbox.tz));
    const text0 = mail.text || htmlToText(mail.html || "");
    // Providers confirm a new forwarding address by emailing it a code or link: show it in the app.
    if (!events.length && /forwarding|confirm|verif/i.test(mail.subject || "") && /forward/i.test((mail.subject || "") + text0.slice(0, 2000))) {
      const link = (text0.match(/https?:\/\/\S+/) || [])[0];
      const code = (text0.match(/\b\d{6,10}\b/) || [])[0];
      await log("confirmation", 0, [code && `Code: ${code}`, link].filter(Boolean).join("  ") || text0.slice(0, 300), mail);
      return;
    }
    if (!events.length) {
      const r = await extractEvents(env, { subject: mail.subject, from: mail.from?.address, sentAt: mail.date, text: text0, timeZone: inbox.tz });
      if (r.skipped) { await log("needs_setup", 0, "Only calendar invites are read until Claude is switched on", mail); return; }
      events = r.events;
    }
    const added = await addEvents(env, inbox.household_id, inbox.member_id, events, { emailSubject: (mail.subject || "").slice(0, 200) });
    await log(added ? "added" : events.length ? "duplicate" : "nothing_found", added, null, mail);
  } catch (e) {
    await log("error", 0, String(e?.message || e).slice(0, 300), mail);
  }
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
