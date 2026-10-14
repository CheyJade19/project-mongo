// Small helpers shared by the API modules.

// The iOS and Android apps call the API from their own origin; auth is a bearer token, not cookies.
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-household",
  "access-control-max-age": "86400",
};

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

// Thrown anywhere in a request; the router turns it into a JSON error the app shows as-is.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomId(length = 16, alphabet = ALPHABET) {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_BODY = 256 * 1024;
export async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "That's too large to save.");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "That request couldn't be read."); }
}

export const validTz = (tz) => { if (typeof tz !== "string" || !tz) return false; try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };
