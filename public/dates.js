// Finds dates and times written in an email ("Fri 21 October at 6pm", "Oct 21, 18:00",
// "21/10/2026") so a person can pick one when they add the email to the calendar.
// Plain pattern matching that runs on the device or server; nothing is sent anywhere.
(function (root) {
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const ORD = "(?:st|nd|rd|th)?";
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const valid = (y, m, d) => {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  };

  // No year written: take the next time that day comes round (allowing a week in the past).
  function inferYear(m, d, ref) {
    const y = ref.getFullYear();
    const candidate = new Date(y, m - 1, d);
    return candidate < new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 7) ? y + 1 : y;
  }

  function toTime(h, min, ap) {
    h = +h; min = +(min || 0);
    if (ap) {
      ap = ap.toLowerCase();
      if (h === 12) h = 0;
      if (ap.startsWith("p")) h += 12;
    }
    return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
  }

  const TIME = /\b(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b([01]?\d|2[0-3])[:h]([0-5]\d)\b|\b(noon|midday)\b/gi;
  function timesIn(text) {
    const out = [];
    let m;
    TIME.lastIndex = 0;
    while ((m = TIME.exec(text))) {
      if (m[6]) out.push({ at: m.index, time: "12:00" });
      else if (m[3]) { const t = toTime(m[1], m[2], m[3].replace(/\./g, "")); if (t) out.push({ at: m.index, time: t }); }
      else { const t = toTime(m[4], m[5]); if (t) out.push({ at: m.index, time: t }); }
    }
    return out;
  }

  function findDates(text, opts = {}) {
    const ref = opts.ref ? new Date(opts.ref) : new Date();
    const dayFirst = opts.dayFirst !== false;
    const src = String(text || "").slice(0, 100000);
    const found = [];
    const add = (index, length, y, m, d) => {
      if (!valid(y, m, d)) return;
      found.push({ index, length, date: ymd(y, m, d) });
    };
    const patterns = [
      // 2026-10-21
      [/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (x) => [+x[1], +x[2], +x[3]]],
      // 21 October 2026, 21st Oct
      [new RegExp(`\\b(\\d{1,2})${ORD}(?:\\s+of)?\\s+${MON}\\.?(?:,?\\s+(20\\d{2}))?\\b`, "gi"), (x) => {
        const m = MONTHS.indexOf(x[2].slice(0, 3).toLowerCase()) + 1;
        return [x[3] ? +x[3] : inferYear(m, +x[1], ref), m, +x[1]];
      }],
      // October 21, 2026 / Oct 21st
      [new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(20\\d{2}))?\\b`, "gi"), (x) => {
        const m = MONTHS.indexOf(x[1].slice(0, 3).toLowerCase()) + 1;
        return [x[3] ? +x[3] : inferYear(m, +x[2], ref), m, +x[2]];
      }],
      // 21/10/2026 or 10/21/2026 (order from the person's region; a day over 12 decides it)
      [/\b(\d{1,2})[\/.](\d{1,2})[\/.](20\d{2}|\d{2})\b/g, (x) => {
        let a = +x[1], b = +x[2];
        const y = x[3].length === 2 ? 2000 + +x[3] : +x[3];
        let [d, m] = dayFirst ? [a, b] : [b, a];
        if (m > 12 && d <= 12) [d, m] = [m, d];
        return [y, m, d];
      }],
    ];
    for (const [re, toParts] of patterns) {
      re.lastIndex = 0;
      let x;
      while ((x = re.exec(src))) {
        const [y, m, d] = toParts(x);
        add(x.index, x[0].length, y, m, d);
      }
    }
    found.sort((a, b) => a.index - b.index);

    // Pair each date with the times written near it, in the same line or sentence.
    const results = [];
    const seen = new Set();
    for (const f of found) {
      if (results.some((r) => f.index >= r.index && f.index < r.index + r.length)) continue;
      const lineStart = Math.max(src.lastIndexOf("\n", f.index) + 1, f.index - 80);
      let lineEnd = src.indexOf("\n", f.index + f.length);
      if (lineEnd < 0 || lineEnd > f.index + f.length + 80) lineEnd = Math.min(src.length, f.index + f.length + 80);
      const near = timesIn(src.slice(lineStart, lineEnd));
      const start = near[0] ? near[0].time : null;
      const end = near[1] && near[1].time > (start || "") ? near[1].time : null;
      const key = `${f.date}|${start || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        index: f.index, length: f.length, date: f.date, start, end,
        snippet: src.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim().slice(0, 140),
      });
      if (results.length >= 12) break;
    }
    return results.map(({ index, length, ...r }) => r);
  }

  root.HouseholdDates = { findDates };
})(typeof window !== "undefined" ? window : globalThis);
