# Household Calendar

A shared calendar for everyone at home, in the spirit of a Skylight wall calendar. Each person has a profile, a colour and their own column of to-dos, and everyone's events sit together on one calendar. Each person also gets a private email address: forward an email to it (from Gmail, Outlook, iCloud, Yahoo or any other provider) and the dates in it land on their calendar.

It runs as:

- **A website** that installs to the home screen on iPhone, iPad and Android (Share › Add to Home Screen).
- **iOS and Android apps** built from the same code with [Capacitor](https://capacitorjs.com), in `ios/` and `android/`.

## How it fits together

```
public/            The app itself (one HTML page, no build step), manifest, service worker, icons
src/worker.js      Cloudflare Worker: serves public/, the /api JSON API, and receives forwarded email
src/ics.js         Reads calendar invites (.ics) and converts times to the household's time zone
src/extract.js     Asks Claude to pull events out of ordinary emails (newsletters, bookings, invites)
schema.sql         D1 (SQLite) tables: households, items (members/events/to-dos), inboxes, inbound log
ios/, android/     Native app shells (Capacitor) that load the same app and talk to your server
scripts/           build-native.mjs prepares the app for the native shells
test/              Unit tests (npm test)
```

**Households and sign-in.** Creating a household returns a secret key that stays on the device. The invite link (Household › Invite your household) carries that key, so anyone you send it to joins the same calendar. Treat it like a house key.

**Email.** Cloudflare Email Routing sends every message for your email domain to the Worker. Each person's address looks like `chey.k3x9q2m1p7aa@inbox.yourfamily.com`; the random part picks the person. The Worker reads calendar invites directly, and asks Claude to find dates in everything else. Events are added to that person's calendar with a "from email" tag, duplicates are skipped, and each email shows up under Recent emails in their Email screen (including the confirmation codes Gmail and Yahoo send when you set up automatic forwarding).

## Set up (about 20 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js 22.

```sh
npm install
npx wrangler login
npx wrangler d1 create household-calendar     # paste the database_id it prints into wrangler.jsonc
npm run db:init
npx wrangler deploy                           # prints your address, e.g. https://household-calendar.<you>.workers.dev
```

Open that address, create your household, and add everyone.

### Turn on email forwarding

1. Add a domain you own to Cloudflare (Cloudflare Registrar sells them at cost if you need one). A subdomain such as `inbox.yourfamily.com` works well.
2. In the Cloudflare dashboard: your domain › **Email › Email Routing** › enable it, then **Routing rules › Catch-all address** › action **Send to a Worker** › `household-calendar`.
3. Set `EMAIL_DOMAIN` in `wrangler.jsonc` to that domain and run `npx wrangler deploy` again.
4. So Claude can read ordinary emails (not just invites), create an API key at [platform.claude.com](https://platform.claude.com) and run `npx wrangler secret put ANTHROPIC_API_KEY`. Without it, only emails with calendar invites attached become events.

Each person then opens **Household › Email** in the app to see their address and step-by-step forwarding instructions for their provider.

### Automatic deploys

`.github/workflows/ci.yml` runs the tests on every push. Add `CLOUDFLARE_API_TOKEN` (a token with the "Edit Cloudflare Workers" template plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID` as repository secrets and every push to `main` deploys too.

## iOS and Android apps

The native apps are thin shells around the same page, so every feature ships to all platforms at once.

```sh
HOUSEHOLD_SERVER=https://household-calendar.<you>.workers.dev npm run cap:sync
npx cap open ios        # needs a Mac with Xcode; run on a device or simulator, then Archive for the App Store
npx cap open android    # needs Android Studio; run, then Build › Generate Signed Bundle for Google Play
```

Change `appId` in `capacitor.config.json` to a reverse-domain name you own before publishing. Store listings need an Apple Developer account ($99/year) and a Google Play developer account ($25 once).

## Develop locally

```sh
npm run db:init:local
npx wrangler dev --var EMAIL_DOMAIN:inbox.example.com
```

To try a forwarded email locally, POST a raw message (it needs a `Message-ID` header) to
`http://localhost:8787/cdn-cgi/handler/email?from=sender@example.com&to=<a person's address>`.

## Roadmap

- Sign in with Google and Microsoft so Gmail and Outlook are read without setting up forwarding.
- Universal links so invite links open straight in the installed apps.
- Push notifications for reminders, and a "today" widget.
- Native app icons and splash screens (`npx @capacitor/assets generate`).
- Recurring events and multi-day events.
