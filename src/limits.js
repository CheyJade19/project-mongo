// Caps that keep one household (or one misbehaving device) from overloading the service.
export const LIMITS = {
  householdsPerUser: 5,
  profilesPerHousehold: 12,
  eventsPerHousehold: 10000,
  todosPerHousehold: 3000,
  forwardedEmailsPerProfilePerDay: 30,
  pendingEmailsPerHousehold: 100,
  invitesOpenPerHousehold: 20,
  docBytes: 64 * 1024,
  photoBytes: 200 * 1024,
  emailBytes: 10 * 1024 * 1024,
};

// Cloudflare's rate limiting binding (see "ratelimits" in wrangler.jsonc). If a binding is
// missing, as in some local setups, requests are allowed rather than failing.
export async function allowed(limiter, key) {
  if (!limiter?.limit) return true;
  try { return (await limiter.limit({ key })).success; } catch { return true; }
}
