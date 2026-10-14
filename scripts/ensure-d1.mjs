// Used by the deploy workflow: finds the household-calendar D1 database (creating it the first
// time) and writes its id into wrangler.jsonc, so nobody has to paste the id by hand.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const NAME = "household-calendar";
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8" });

let db = JSON.parse(wrangler("d1", "list", "--json")).find((d) => d.name === NAME);
if (!db) {
  console.log(`Creating D1 database ${NAME}`);
  wrangler("d1", "create", NAME);
  db = JSON.parse(wrangler("d1", "list", "--json")).find((d) => d.name === NAME);
}
if (!db?.uuid) throw new Error(`Couldn't find the ${NAME} database after creating it`);

const config = readFileSync("wrangler.jsonc", "utf8");
writeFileSync("wrangler.jsonc", config.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${db.uuid}"`));
console.log(`Using D1 database ${db.uuid}`);
