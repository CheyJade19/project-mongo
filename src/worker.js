// Household Calendar: serves the app (from /public), a small JSON API under /api,
// and receives the emails people choose to forward to their private address.
// Forwarded emails wait in that person's "To review" list; nothing reaches the calendar
// until they pick what to add, and the email's text is deleted once they have.
import PostalMime from "postal-mime";
import { parseICS } from "./ics.js";
import { htmlToText } from "./text.js";
import { CORS, HttpError, json, randomId, readJson, validTz } from "./util.js";
import { LIMITS, allowed } from "./limits.js";
import { authConfig, authRoutes, createInvite, currentUser, deleteHousehold } from "./auth.js";
import "../public/dates.js";

const { findDates } = globalThis.HouseholdDates;
const KEEP_PENDING_DAYS = 14;

const COLS = new Set(["members", "events", "todos"]);
const COL_LIMIT = { members: LIMITS.profilesPerHousehold, events: LIMITS.eventsPerHousehold, todos: LIMITS.todosPerHousehold };
const COL_NAME = { members: "profiles", events: "events", todos: "to-dos" };

const slug = (s) => (s || "me").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16) || "me";

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

// The household the request is for (x-household header), checked against the person's memberships.
async function householdFor(request, env, user) {
  const id = request.headers.get("x-household") || "";
  if (!id) throw new HttpError(400, "Pick a household first.");
  const h = await env.DB.prepare(
    "SELECT h.id, h.name, h.tz, m.role FROM memberships m JOIN households h ON h.id = m.household_id WHERE m.user_id = ? AND m.household_id = ?",
  ).bind(user.id, id).first();
  if (!h) throw new HttpError(403, "You're no longer part of that household.");
  return h;
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
  return {
    household: { id: h.id, name: h.name, tz: h.tz, role: h.role, emailEnabled: !!env.EMAIL_DOMAIN },
    ...state,
    inbound: inboundRows,
  };
}

async function countItems(env, hid, col) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE household_id = ? AND col = ?").bind(hid, col).first()).n;
}

async function putItem(env, hid, col, id, data) {
  const { id: _drop, inbox: _inbox, ...body } = data && typeof data === "object" ? data : {};
  const text = JSON.stringify(body);
  if (text.length > LIMITS.docBytes) throw new HttpError(413, "That's too large to save.");
  await env.DB.prepare(
    "INSERT INTO items (household_id, col, id, data, updated_at) VALUES (?, ?, ?, ?, datetime('now')) " +
    "ON CONFLICT (household_id, col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ).bind(hid, col, id, text).run();
}

async function addEvents(env, hid, memberIds, events, extra) {
  const existing = await env.DB.prepare("SELECT data FROM items WHERE household_id = ? AND col = 'events'").bind(hid).all();
  if (existing.results.length + events.length > LIMITS.eventsPerHousehold) {
    throw new HttpError(403, `This household has reached its limit of ${LIMITS.eventsPerHousehold} events. Delete some old ones first.`);
  }
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
  const ip = request.headers.get("cf-connecting-ip") || "local";

  if (path[0] === "config" && method === "GET") return json({ auth: authConfig(env), emailEnabled: !!env.EMAIL_DOMAIN });

  const accountResponse = await authRoutes(request, env, path, ip);
  if (accountResponse) return accountResponse;

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in again.");
  if (!(await allowed(env.API_LIMIT, `api:${user.id}`))) throw new HttpError(429, "That's a lot of changes at once. Wait a moment and try again.");

  if (path[0] === "households" && method === "POST" && path.length === 1) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?").bind(user.id).first();
    if (count.n >= LIMITS.householdsPerUser) throw new HttpError(403, `You can be in up to ${LIMITS.householdsPerUser} households.`);
    const body = await readJson(request);
    const name = String(body.name || "Our household").trim().slice(0, 60) || "Our household";
    const tz = validTz(body.tz) ? body.tz : "UTC";
    const id = randomId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households (id, name, tz) VALUES (?, ?, ?)").bind(id, name, tz),
      env.DB.prepare("INSERT INTO memberships (user_id, household_id, role) VALUES (?, ?, 'owner')").bind(user.id, id),
    ]);
    return json({ household: { id, name, role: "owner" } });
  }

  const h = await householdFor(request, env, user);
  const owner = h.role === "owner";
  const ownerOnly = () => { if (!owner) throw new HttpError(403, "Only the household's owner can do that."); };

  if (path[0] === "state" && method === "GET") return json(await loadState(env, h));

  if (path[0] === "household") {
    if (!path[1] && method === "PATCH") {
      const body = await readJson(request);
      const name = body.name ? String(body.name).trim().slice(0, 60) || h.name : h.name;
      const tz = validTz(body.tz) ? body.tz : h.tz;
      await env.DB.prepare("UPDATE households SET name = ?, tz = ? WHERE id = ?").bind(name, tz, h.id).run();
      return json({ ok: true });
    }
    // Deletes the household and everything in it, for everyone.
    if (!path[1] && method === "DELETE") {
      ownerOnly();
      await deleteHousehold(env, h.id);
      return json({ ok: true });
    }
    if (path[1] === "invites" && method === "POST") return json(await createInvite(env, h.id, user.id));
    if (path[1] === "leave" && method === "POST") {
      const others = await env.DB.prepare("SELECT user_id FROM memberships WHERE household_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1").bind(h.id, user.id).first();
      if (!others) throw new HttpError(400, "You're the only person here. Delete the household instead.");
      const steps = [env.DB.prepare("DELETE FROM memberships WHERE household_id = ? AND user_id = ?").bind(h.id, user.id)];
      if (owner) steps.push(env.DB.prepare("UPDATE memberships SET role = 'owner' WHERE household_id = ? AND user_id = ?").bind(h.id, others.user_id));
      await env.DB.batch(steps);
      return json({ ok: true });
    }
    // Everyone who can sign in to this household (accounts, not calendar profiles).
    if (path[1] === "people" && !path[2] && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT u.id, u.name, u.email, m.role, m.joined_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.joined_at",
      ).bind(h.id).all();
      return json({ people: rows.results.map((p) => ({ ...p, you: p.id === user.id })) });
    }
    if (path[1] === "people" && path[2] && method === "DELETE") {
      ownerOnly();
      if (path[2] === user.id) throw new HttpError(400, "To leave, use Leave household.");
      await env.DB.prepare("DELETE FROM memberships WHERE household_id = ? AND user_id = ?").bind(h.id, path[2]).run();
      return json({ ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  // A person reviews one forwarded email: add the events they picked, or dismiss it.
  // Either way the email's text is deleted from the server.
  if (path[0] === "inbound" && path[1]) {
    const row = await env.DB.prepare("SELECT id, member_id, subject, status FROM inbound WHERE id = ? AND household_id = ?").bind(path[1], h.id).first();
    if (!row) throw new HttpError(404, "That email is no longer here.");
    if (method === "POST" && path[2] === "accept") {
      const body = await readJson(request);
      const memberIds = Array.isArray(body.memberIds) && body.memberIds.length ? body.memberIds.map(String).slice(0, 20) : [row.member_id];
      const events = (Array.isArray(body.events) ? body.events : []).slice(0, 50).map(cleanEvent).filter(Boolean);
      if (!events.length) throw new HttpError(400, "Pick at least one event to add.");
      const added = await addEvents(env, h.id, memberIds, events, { emailSubject: (row.subject || "").slice(0, 200) });
      await env.DB.prepare("UPDATE inbound SET status = 'added', event_count = ?, payload = NULL WHERE id = ?").bind(added, row.id).run();
      return json({ added });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE inbound SET status = 'dismissed', payload = NULL WHERE id = ?").bind(row.id).run();
      return json({ ok: true });
    }
    throw new HttpError(405, "Not allowed");
  }

  const [col, id] = path;
  if (!COLS.has(col)) throw new HttpError(404, "Not found");

  if (method === "POST" && !id) {
    if ((await countItems(env, h.id, col)) >= COL_LIMIT[col]) {
      throw new HttpError(403, `This household has reached its limit of ${COL_LIMIT[col]} ${COL_NAME[col]}.`);
    }
    const newId = randomId();
    await putItem(env, h.id, col, newId, await readJson(request));
    if (col === "members") await ensureInbox(env, h.id, newId);
    return json({ id: newId });
  }
  if (method === "PUT" && id) {
    const exists = await env.DB.prepare("SELECT 1 FROM items WHERE household_id = ? AND col = ? AND id = ?").bind(h.id, col, id).first();
    if (!exists && (await countItems(env, h.id, col)) >= COL_LIMIT[col]) {
      throw new HttpError(403, `This household has reached its limit of ${COL_LIMIT[col]} ${COL_NAME[col]}.`);
    }
    await putItem(env, h.id, col, id, await readJson(request));
    if (col === "members") await ensureInbox(env, h.id, id);
    return json({ ok: true });
  }
  if (method === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM items WHERE household_id = ? AND col = ? AND id = ?").bind(h.id, col, id).run();
    if (col === "members") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM inboxes WHERE household_id = ? AND member_id = ?").bind(h.id, id),
        env.DB.prepare("DELETE FROM inbound WHERE household_id = ? AND member_id = ?").bind(h.id, id),
      ]);
    }
    return json({ ok: true });
  }
  throw new HttpError(405, "Not allowed");
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

  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inbound WHERE member_id = ? AND household_id = ? AND received_at > datetime('now', '-1 day')",
  ).bind(inbox.member_id, inbox.household_id).first();
  if (today.n >= LIMITS.forwardedEmailsPerProfilePerDay) { message.setReject("Too many emails forwarded today. Try again tomorrow."); return; }

  const save = (status, mail, payload) =>
    env.DB.prepare("INSERT INTO inbound (id, household_id, member_id, from_addr, subject, status, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId(), inbox.household_id, inbox.member_id, (mail?.from?.address || message.from || "").slice(0, 200),
        (mail?.subject || "").slice(0, 200), status, payload ? JSON.stringify(payload) : null).run();

  if (message.rawSize > LIMITS.emailBytes) { await save("too_large", null, null); return; }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM inbound WHERE household_id = ? AND status = 'pending'").bind(inbox.household_id).first();
  if (pending.n >= LIMITS.pendingEmailsPerHousehold) { await save("over_limit", null, null); return; }

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
      catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e);
        return json({ error: "Something went wrong. Try again." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async email(message, env) {
    await receiveEmail(message, env);
  },
};
