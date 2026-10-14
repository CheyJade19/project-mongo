// Copies the web app into native-www/ for the iOS and Android apps, pointing it at your server.
// Usage: HOUSEHOLD_SERVER=https://household-calendar.<you>.workers.dev npm run build:native
import { cpSync, rmSync, writeFileSync } from "node:fs";

const server = (process.env.HOUSEHOLD_SERVER || "").replace(/\/$/, "");
if (!/^https:\/\//.test(server)) {
  console.error("Set HOUSEHOLD_SERVER to your deployed address, e.g. https://household-calendar.example.workers.dev");
  process.exit(1);
}
rmSync("native-www", { recursive: true, force: true });
cpSync("public", "native-www", { recursive: true });
rmSync("native-www/sw.js", { force: true }); // the native apps bundle their files already
writeFileSync("native-www/config.js", `window.HOUSEHOLD_SERVER = ${JSON.stringify(server)};\n`);
console.log(`native-www/ ready, using ${server}`);
