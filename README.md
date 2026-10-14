# Household Calendar

A shared calendar for everyone at home, in the spirit of a Skylight wall calendar. Each person has a profile, a colour and their own column of to-dos, and everyone's events sit together on one calendar.

People add events from email on their own terms. The app never connects to anyone's inbox and uses no AI: each person picks an email or invite themselves, sees what was found in it, and chooses what goes on the calendar.

## Who does what

**You (the owner) host it once.** One Cloudflare account runs the server for every household that uses the app. You set it up, publish the iOS and Android apps, and keep an eye on it.

**Everyone else just downloads the app.** They install it from the App Store or Google Play (or open the website), sign in with Apple, Google or their email, and start or join a household. They never see Cloudflare or set anything up.

It runs as:

- **iOS and Android apps** built from the same code with [Capacitor](https://capacitorjs.com), in `ios/` and `android/`.
- **A website** at your server's address, which also installs to the home screen.

## How it fits together

```
public/            The app (one HTML page, no build step), privacy and support pages, service worker, icons
src/worker.js      Cloudflare Worker: serves public/, the /api JSON API, and receives forwarded email
src/auth.js        Accounts: Sign in with Apple and Google (ID token checks), email codes, invites, deletion
src/limits.js      Usage limits per person and per household, and request rate limits
src/ics.js         Reads calendar invites (.ics) and converts times to the household's time zone
src/text.js        Turns HTML emails into plain text
public/dates.js    Finds written dates and times ("Wed 21 October at 6pm") with plain pattern matching
schema.sql         D1 (SQLite) tables: users, sign-ins, sessions, households, memberships, invites, items, email
ios/, android/     Native app shells (Capacitor) that load the same app and talk to your server
scripts/           Native build, first-deploy database setup, and a one-time reset for old test data
test/              Unit tests (npm test)
```

**Accounts and households.** Each person signs in with Apple, Google, or a six-digit code sent to their email. A household has an owner and members. Anyone in it can create an invite (an 8-character code and link that works for 7 days and up to 10 people). The owner can remove people or delete the household. Everyone can leave a household, sign out, or delete their account from **Household › Account and privacy**, as the App Store and Google Play require.

**Finding your way around.** A navigation bar runs down the left of the screen on iPad and wider screens, and along the bottom on phones. **Calendar** is at the top; **Profile** is at the bottom. New areas of the app get their own icon in the bar as they're added.

**Profile and settings.** Under Profile each person sets their name, picks which person on the calendar is them (with its colour and a letter or emoji picture), and finds the household, invite and account options. Settings for the device are there too: light or dark, which view the calendar opens on, whether the week starts on Monday or Sunday, 12- or 24-hour time, and keeping the screen on for a wall display.

**Email, always the person's choice.** There are three ways to add events from email, and nothing happens without the person choosing it:

1. **Open an invite in the app.** In Mail, Gmail or Outlook, tap the invite (.ics) and choose Household (iOS "Open in", Android "Open with", or the share sheet for the installed website on Android). The app shows the events and the person ticks the ones to add.
2. **Paste or choose a file.** Under From email, paste the part of an email with the date, or choose a saved email (.eml) or invite. It's read on the device only; dates written in it are offered as suggestions.
3. **Forward one email.** Each profile has a private address such as `chey.k3x9q2m1p7aa@inbox.yourapp.com`. An email forwarded there waits under **To review**. Nothing is added until the person picks what to add, and the email's text is deleted as soon as they add from it or dismiss it, or after 14 days.

There are no forwarding rules, no inbox access, and no AI anywhere in the app. The privacy policy is at `/privacy.html` and help is at `/support.html`.

**Limits.** So one household can't overload the service for everyone, `src/limits.js` caps each person at 5 households, and each household at 12 profiles, 10,000 events, 3,000 to-dos, 100 emails waiting for review and 20 open invites. Each profile can forward 30 emails a day. Sign-in attempts are limited to 10 a minute per device and API calls to 120 a minute per person.

## Owner setup

### 1. The server (about 20 minutes)

You need a [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js 22.

```sh
npm install
npx wrangler login
npx wrangler d1 create household-calendar     # paste the database_id it prints into wrangler.jsonc
npm run db:init
npx wrangler deploy                           # prints your address, e.g. https://household-calendar.<you>.workers.dev
```

Or let GitHub do it: add the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (GitHub › Settings › Secrets and variables › Actions). Every push to `main` then runs the tests and deploys, creating the database the first time. The token comes from Cloudflare › My Profile › API Tokens › Create Token › "Edit Cloudflare Workers" template, plus Account › D1 › Edit.

If your database was created before accounts existed, the deploy workflow clears the old test data once (`scripts/reset-before-accounts.sql`). Deploying by hand, run that file once before `npm run db:init`.

### 2. Sign-in

Each option appears in the app once it's configured. Set the values in `wrangler.jsonc` under `vars` and deploy.

**Email codes** (simplest, works everywhere):

1. Create a free [Resend](https://resend.com) account and verify a domain you own for sending.
2. `npx wrangler secret put RESEND_API_KEY` and paste the API key.
3. Set `MAIL_FROM`, for example `Household <sign-in@yourfamily.com>`.

**Sign in with Google:**

1. In [Google Cloud Console](https://console.cloud.google.com) › APIs & Services › Credentials, configure the OAuth consent screen, then create OAuth client IDs: a **Web application** (add your server's address under Authorized JavaScript origins), an **iOS** client (bundle id from `capacitor.config.json`), and an **Android** client (package name plus your signing key's SHA-1).
2. Set `GOOGLE_CLIENT_IDS` to the web client id, then the iOS client id, comma separated.
3. For iOS, add the iOS client's reversed id (`com.googleusercontent.apps.…`) as a URL scheme in `ios/App/App/Info.plist`.

**Sign in with Apple** (the App Store requires it when Google sign-in is offered):

1. In your [Apple Developer account](https://developer.apple.com/account) › Identifiers, turn on Sign in with Apple for the app's App ID, and in Xcode add the Sign in with Apple capability.
2. For the website, create a **Services ID** (for example `com.yourfamily.household.web`), turn on Sign in with Apple, and add your server's domain and return URL (`https://<your address>/`).
3. Set `APPLE_CLIENT_IDS` to the Services ID, then the app's bundle id, comma separated.

On Android, Apple sign-in is hidden; people there use Google or email.

### 3. Email forwarding (optional)

1. Add a domain you own to Cloudflare. A subdomain such as `inbox.yourfamily.com` works well.
2. In the Cloudflare dashboard: your domain › **Email › Email Routing** › enable it, then **Routing rules › Catch-all address** › **Send to a Worker** › `household-calendar`.
3. Set `EMAIL_DOMAIN` to that domain and deploy.

### 4. The store apps

The native apps are thin shells around the same page, pointed at your server, so every feature ships to all platforms at once.

```sh
HOUSEHOLD_SERVER=https://household-calendar.<you>.workers.dev npm run cap:sync
npx cap open ios        # needs a Mac with Xcode; run on a device, then Archive for the App Store
npx cap open android    # needs Android Studio; run, then Build › Generate Signed Bundle for Google Play
```

Before publishing:

- Change `appId` in `capacitor.config.json` to a reverse-domain name you own.
- Replace `support@example.com` in `public/privacy.html` and `public/support.html` with your contact address, and use `https://<your address>/privacy.html` as the privacy policy URL in both store listings.
- Store listings need an Apple Developer account ($99/year) and a Google Play developer account ($25 once).

## Develop locally

```sh
npm run db:init:local
echo DEV_MODE=1 > .dev.vars          # email sign-in codes come back in the response instead of being sent
npx wrangler dev --var EMAIL_DOMAIN:inbox.example.com
```

To try a forwarded email locally, POST a raw message (it needs a `Message-ID` header) to
`http://localhost:8787/cdn-cgi/handler/email?from=sender@example.com&to=<a person's address>`.

## Roadmap

- An iOS share extension so text selected in any email can be shared straight to Household.
- Universal links so invite links open straight in the installed apps.
- Push notifications for reminders, and a "today" widget.
- Native app icons and splash screens (`npx @capacitor/assets generate`).
- Recurring events and multi-day events.
