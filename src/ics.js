// Minimal iCalendar (.ics) reader for invites and calendar exports.
// Returns [{uid, title, date, allDay, start, end, location}] with dates in the household's time zone.

const pad = (n) => String(n).padStart(2, "0");

function partsInZone(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Offset (minutes) of `timeZone` at the given UTC instant.
function zoneOffset(utcMs, timeZone) {
  const { date, time } = partsInZone(new Date(utcMs), timeZone);
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return (Date.UTC(y, m - 1, d, hh, mm) - utcMs) / 60000;
}

export function icsDate(value, params, timeZone) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return {};
  const [, y, mo, d, hh, mi, , z] = m;
  if (!hh) return { date: `${y}-${mo}-${d}` };
  let utc;
  if (z) utc = Date.UTC(+y, mo - 1, +d, +hh, +mi);
  else {
    const tzid = (params.match(/TZID=([^;:]+)/i) || [])[1];
    if (!tzid) return { date: `${y}-${mo}-${d}`, time: `${hh}:${mi}` }; // floating time
    try {
      const guess = Date.UTC(+y, mo - 1, +d, +hh, +mi);
      utc = guess - zoneOffset(guess, tzid.replace(/^"|"$/g, "")) * 60000;
    } catch {
      return { date: `${y}-${mo}-${d}`, time: `${hh}:${mi}` };
    }
  }
  return partsInZone(new Date(utc), timeZone);
}

const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

export function parseICS(text, timeZone = "UTC") {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur && cur.date && !cur.cancelled) out.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const params = line.slice(0, i);
      const key = params.split(";")[0].toUpperCase();
      const v = line.slice(i + 1);
      if (key === "SUMMARY") cur.title = unescape(v);
      else if (key === "LOCATION") cur.location = unescape(v) || null;
      else if (key === "UID") cur.uid = v.trim();
      else if (key === "STATUS" && /CANCELLED/i.test(v)) cur.cancelled = true;
      else if (key === "DTSTART") {
        const d = icsDate(v, params, timeZone);
        cur.date = d.date; cur.start = d.time || null; cur.allDay = !d.time;
      } else if (key === "DTEND") cur.end = icsDate(v, params, timeZone).time || null;
    }
  }
  return out.map(({ cancelled, ...e }) => ({ ...e, title: e.title || "Untitled" }));
}

export { pad };
