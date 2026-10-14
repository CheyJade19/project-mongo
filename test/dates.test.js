import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/dates.js";

const { findDates } = globalThis.HouseholdDates;
const ref = new Date(2026, 9, 14); // 14 October 2026

test("written-out dates with times nearby", () => {
  const r = findDates("Hi all,\nThe school concert is on Wednesday 21st October at 6pm in the hall.\nThanks", { ref });
  assert.deepEqual(r.map((x) => [x.date, x.start]), [["2026-10-21", "18:00"]]);
});

test("month first, 24-hour ranges, and a year", () => {
  const r = findDates("Booking confirmed: Nov 3, 2026, 09:30 - 11:00", { ref });
  assert.deepEqual(r.map((x) => [x.date, x.start, x.end]), [["2026-11-03", "09:30", "11:00"]]);
});

test("numeric dates follow the person's region", () => {
  assert.equal(findDates("Due 03/11/2026", { ref }).at(0).date, "2026-11-03");
  assert.equal(findDates("Due 03/11/2026", { ref, dayFirst: false }).at(0).date, "2026-03-11");
  assert.equal(findDates("Due 25/12/2026", { ref, dayFirst: false }).at(0).date, "2026-12-25");
});

test("dates without a year roll into next year once passed", () => {
  assert.equal(findDates("Sports day 5 March", { ref }).at(0).date, "2027-03-05");
});

test("no invented dates", () => {
  assert.deepEqual(findDates("Thanks for your order! Reference 4471-22.", { ref }), []);
  assert.deepEqual(findDates("31 February", { ref }), []);
});
