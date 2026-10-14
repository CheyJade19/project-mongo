import { test } from "node:test";
import assert from "node:assert/strict";
import { parseICS } from "../src/ics.js";
import { htmlToText } from "../src/text.js";

const wrap = (body) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test("UTC times convert to the household's time zone", () => {
  const [e] = parseICS(wrap("UID:a\r\nSUMMARY:Match\r\nDTSTART:20261017T080000Z\r\nDTEND:20261017T093000Z"), "Africa/Johannesburg");
  assert.deepEqual([e.date, e.start, e.end, e.allDay], ["2026-10-17", "10:00", "11:30", false]);
});

test("TZID times convert between zones", () => {
  const [e] = parseICS(wrap("SUMMARY:Call\r\nDTSTART;TZID=Europe/London:20261020T090000"), "Africa/Johannesburg");
  assert.deepEqual([e.date, e.start], ["2026-10-20", "10:00"]); // London is UTC+1 in October, Johannesburg UTC+2
});

test("all-day events and escaped text", () => {
  const [e] = parseICS(wrap("SUMMARY:Bake sale\\, hall\r\nDTSTART;VALUE=DATE:20261101\r\nLOCATION:School"), "UTC");
  assert.deepEqual([e.title, e.date, e.allDay, e.start, e.location], ["Bake sale, hall", "2026-11-01", true, null, "School"]);
});

test("folded lines and cancelled events", () => {
  const text = wrap("SUMMARY:Very long\r\n  title\r\nDTSTART:20261101T100000") + wrap("SUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART:20261102T100000");
  const events = parseICS(text, "UTC");
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Very long title");
});

test("html emails become readable text", () => {
  assert.equal(htmlToText("<style>p{}</style><p>Concert&nbsp;on <b>21 Oct</b></p><p>6pm</p>"), "Concert on 21 Oct\n6pm");
});
