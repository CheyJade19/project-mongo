import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyIdToken, normaliseInvite, authConfig } from "../src/auth.js";
import { allowed } from "../src/limits.js";

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const fetcher = async () => new Response(JSON.stringify({ keys: [jwk] }));

async function sign(claims, header = { alg: "RS256", kid: "k1" }) {
  const body = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

const env = { GOOGLE_CLIENT_IDS: "web.apps.googleusercontent.com,ios.apps.googleusercontent.com", APPLE_CLIENT_IDS: "com.example.web,com.householdcalendar.app" };
const now = Date.UTC(2026, 9, 14);
const exp = now / 1000 + 600;

test("accepts a valid Google token for any configured client", async () => {
  const token = await sign({ iss: "https://accounts.google.com", aud: "ios.apps.googleusercontent.com", sub: "123", email: "A@x.com", email_verified: true, name: "Ann", exp });
  assert.deepEqual(await verifyIdToken("google", token, env, fetcher, now), { subject: "123", email: "a@x.com", name: "Ann" });
});

test("ignores an unverified email", async () => {
  const token = await sign({ iss: "https://appleid.apple.com", aud: "com.householdcalendar.app", sub: "a1", email: "b@x.com", email_verified: "false", exp });
  assert.equal((await verifyIdToken("apple", token, env, fetcher, now)).email, null);
});

test("rejects wrong audience, issuer, expiry and tampered tokens", async () => {
  const bad = [
    await sign({ iss: "https://accounts.google.com", aud: "someone-else", sub: "1", exp }),
    await sign({ iss: "https://evil.example", aud: "web.apps.googleusercontent.com", sub: "1", exp }),
    await sign({ iss: "https://accounts.google.com", aud: "web.apps.googleusercontent.com", sub: "1", exp: now / 1000 - 3600 }),
    (await sign({ iss: "https://accounts.google.com", aud: "web.apps.googleusercontent.com", sub: "1", exp })).replace(/\.[^.]+\./, `.${enc({ iss: "https://accounts.google.com", aud: "web.apps.googleusercontent.com", sub: "2", exp })}.`),
    await sign({ iss: "https://accounts.google.com", aud: "web.apps.googleusercontent.com", sub: "1", exp }, { alg: "none", kid: "k1" }),
  ];
  for (const t of bad) await assert.rejects(verifyIdToken("google", t, env, fetcher, now), (e) => e.status === 401);
});

test("refuses a provider that isn't set up", async () => {
  await assert.rejects(verifyIdToken("apple", "a.b.c", {}, fetcher, now), (e) => e.status === 400);
});

test("sign-in options follow the configuration", () => {
  assert.deepEqual(authConfig({}), { google: null, apple: null, email: false });
  assert.deepEqual(authConfig({ ...env, DEV_MODE: "1" }), {
    google: { web: "web.apps.googleusercontent.com", ios: "ios.apps.googleusercontent.com" },
    apple: { web: "com.example.web" },
    email: true,
  });
});

test("invite codes are read from links and loose typing", () => {
  assert.equal(normaliseInvite("https://app.example/?invite=ab3d-ef7h"), "AB3DEF7H");
  assert.equal(normaliseInvite(" ab3d ef7h "), "AB3DEF7H");
});

test("rate limits allow when no limiter is bound and follow the limiter otherwise", async () => {
  assert.equal(await allowed(undefined, "k"), true);
  assert.equal(await allowed({ limit: async () => ({ success: false }) }, "k"), false);
  assert.equal(await allowed({ limit: async () => { throw new Error("down"); } }, "k"), true);
});
