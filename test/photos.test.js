import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePhoto } from "../src/worker.js";

const url = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

test("accepts a small JPEG", () => {
  const p = decodePhoto(url("image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  assert.equal(p.type, "image/jpeg");
  assert.equal(p.bytes.length, 7);
});

test("rejects other file types and mislabelled files", () => {
  assert.throws(() => decodePhoto(url("image/svg+xml", [60, 115, 118, 103])), /JPEG, PNG or WebP/);
  assert.throws(() => decodePhoto(url("image/png", [0xff, 0xd8, 0xff])), /isn't a photo/);
  assert.throws(() => decodePhoto("not a data url"), /JPEG, PNG or WebP/);
});

test("rejects a photo over the size limit", () => {
  const big = new Uint8Array(300 * 1024); big.set([0xff, 0xd8, 0xff]);
  assert.throws(() => decodePhoto(url("image/jpeg", big)), /too large/);
});
