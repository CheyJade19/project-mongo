# Household Calendar

A shared calendar for everyone at home, in the spirit of a Skylight wall calendar. Each person has a profile, a colour and their own column of to-dos, and everyone's events sit together on one calendar.

People add events from email on their own terms. The app never connects to anyone's inbox and uses no AI: each person picks an email or invite themselves, sees what was found in it, and chooses what goes on the calendar.

It runs as:

- **A website** that installs to the home screen on iPhone, iPad and Android (Share › Add to Home Screen).
- **iOS and Android apps** built from the same code with [Capacitor](https://capacitorjs.com), in `ios/` and `android/`.

## How it fits together

```
public/            The app itself (one HTML page, no build step), manifest, service worker, icons
src/worker.js      Cloudflare Worker: serves public/, the /api JSON API, and receives forwarded email
src/ics.js         Reads calendar invites (.ics) and converts times to the household's time zone
src/text.js        Turns HTML emails into plain text
public/dates.js    Finds written dates and times ("Wed 21 October at 6pm") with plain pattern matching
schema.sql         D1 (SQLite) tables: households, items (members/events/to-dos), inboxes, inbound log
ios/, android/     Native app shells (Capacitor) that load the same app and talk to your server
scripts/           build-native.mjs prepares the app for the native shells
test/              Unit tests (npm test)
```

**Households and sign-in.** Creating a household returns a secret key that stays on the device. The invite link (Household › Invite your household) carries that key, so anyone you send it to joins the same calendar. Treat it like a house key.

**Email, always the person's choice.** There are three ways to add events from email, and nothing happens without the person choosing it:

1. **Open an invite in the app.** In Mail, Gmail or Outlook, tap the invite (.ics) and choose Household (iOS "Open in", Android "Open with", or the share sheet for the installed website on Android). The app shows the events and the person ticks the ones to add.
2. **Paste or choose a file.** Under From email, paste the part of an email with the date, or choose a saved email (.eml) or invite. It's read on the device only; dates written in it are offered as suggestions.
3. **Forward one email.** Each person has a private address such as `chey.k3x9q2m1p7aa@inbox.yourapp.com`. An email they forward there waits under **To review**. Nothing is added until they open it and pick what to add, and the email's text is deleted from the server as soon as they add from it or dismiss it, or after 14 days.

There are no forwarding rules, no inbox access, and no AI anywhere in the app.

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
Each person then opens **Household › Email** in the app to see their address and how to forward a single email from their provider.

### Automatic deploys

`.github/workflows/ci.yml` runs the tests on every push. Add two repository secrets (GitHub › Settings › Secrets and variables › Actions) and every push to `main` deploys too, creating the database the first time:

- `CLOUDFLARE_ACCOUNT_ID`: on the Cloudflare dashboard home, open the ⋯ menu next to your account name › Copy account ID.
- `CLOUDFLARE_API_TOKEN`: My Profile › API Tokens › Create Token › use the "Edit Cloudflare Workers" template, add the permission Account › D1 › Edit, then create it.

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

- Sign in with Apple, Google or email so a household survives a lost phone.
- An iOS share extension so text selected in any email can be shared straight to Household.
- Universal links so invite links open straight in the installed apps.
- Push notifications for reminders, and a "today" widget.
- Native app icons and splash screens (`npx @capacitor/assets generate`).
- Recurring events and multi-day events.
