import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID } from "./helpers.js";

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const PR = "/api/v1/progress";

test("progress: put, get one, get all", async () => {
  assert.equal((await t.get(`${PR}/${VID(1)}`)).status, 404);
  let r = await t.put(`${PR}/${VID(1)}`, { pos: 12.5, dur: 100, done: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.pos, 12.5);
  assert.equal(r.json.done, false);
  assert.ok(r.json.updated > 0);

  r = await t.put(`${PR}/${VID(1)}`, { pos: 99, dur: 100, done: true });
  assert.equal(r.json.done, true);
  await t.put(`${PR}/${VID(2)}`, { pos: 3 });

  r = await t.get(`${PR}/${VID(1)}`);
  assert.equal(r.json.pos, 99);
  r = await t.get(PR);
  assert.deepEqual(Object.keys(r.json.progress).sort(), [VID(1), VID(2)]);
  assert.deepEqual(Object.keys(r.json.progress[VID(1)]).sort(), ["done", "dur", "pos", "updated"]);   // same shape as the UI's aq.watch.v1
});

test("progress validation", async () => {
  assert.equal((await t.put(`${PR}/short`, { pos: 1 })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, { pos: -1 })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, { pos: "5" })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, { pos: 1e12 })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, { pos: 1, done: "yes" })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, { pos: 1, updated: -3 })).status, 400);
  assert.equal((await t.put(`${PR}/${VID(3)}`, "[]")).status, 400);
  assert.equal((await t.get(`${PR}/${VID(3)}`)).status, 404);          // nothing was stored by the failed attempts
});

test("progress: an older update does not overwrite a newer one", async () => {
  await t.put(`${PR}/${VID(4)}`, { pos: 50, dur: 100, updated: 2_000_000 });
  const r = await t.put(`${PR}/${VID(4)}`, { pos: 10, dur: 100, updated: 1_000_000 });
  assert.equal(r.json.stale, true);
  assert.equal(r.json.pos, 50);
  assert.equal((await t.put(`${PR}/${VID(4)}`, { pos: 60, updated: 3_000_000 })).json.pos, 60);
});
