import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID, JOB } from "./helpers.js";

/** A stand-in for the Python worker's /api/smart, handed to the app as its fetch (no network). */
function fakeWorker() {
  const w = { created: [], jobs: new Map(), next: 1, offline: false, busy: false, hits: 0 };
  const reply = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } });
  w.fetch = async (url, init = {}) => {
    if (w.offline) throw new TypeError("fetch failed");
    const p = new URL(url).pathname, method = init.method || "GET";
    let m;
    if (method === "POST" && p === "/api/smart") {
      if (w.busy) return reply(429, { error: "busy" });
      const body = JSON.parse(init.body), id = JOB(w.next++);
      w.created.push({ id, body });
      w.jobs.set(id, { status: "running", pct: 25, stage: "profiling", message: "Profiling" });
      return reply(202, { job_id: id });
    }
    if (method === "GET" && (m = /^\/api\/smart\/([a-f0-9]{32})$/.exec(p))) {
      w.hits++;
      const j = w.jobs.get(m[1]);
      return j ? reply(200, j) : reply(404, { error: "Job not found" });
    }
    return reply(404, { error: "nope" });
  };
  return w;
}

const RESULT = (ids) => ({
  goal: "Goal", path_summary: "Start with the basics.",
  order: ids.map((id) => ({ video_id: id, reason: "why here" })), unplaced: [], off_goal: [],
  areas: [{ area: "Caching", why: "w", status: "missing", covered_by: [], priority: "high" }],
  suggestions: [], video_topics: {}, checks: ["ok"], stats: { topics_claimed: 3, topics_grounded: 3 }
});
const USAGE = { calls: 3, total_tokens: 1234, wall_seconds: 9.5, api_seconds: 8, waiting_seconds: 0 };

let w, t;
const S = "/api/v1/playlists/goal/smart";
beforeEach(async () => {
  w = fakeWorker();
  t = await startApp({ fetchImpl: w.fetch });
  await t.post("/api/v1/playlists", { id: "goal", name: "Goal", videos: [{ id: VID(1), title: "one", channel: "c", duration: "3:00" }, { id: VID(2), title: "two" }, { id: VID(3), title: "three" }] });
});
afterEach(async () => { await t.close(); });

const finish = (id, extra = {}) => Object.assign(w.jobs.get(id), { status: "done", pct: 100, result: RESULT([VID(1), VID(2), VID(3)]), usage: USAGE }, extra);

test("no run yet: state 'none'", async () => {
  const r = await t.get(S);
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "none");
  assert.equal(r.json.result, undefined);
});

test("start -> poll -> ready; the result is stored, then served without asking the worker", async () => {
  let r = await t.post(S);
  assert.equal(r.status, 202);
  assert.equal(r.json.state, "queued");
  assert.equal(r.json.current, true);
  assert.equal(r.json.provider, "gemini");
  assert.equal(r.json.result, undefined);
  const sent = w.created[0].body;
  assert.equal(sent.goal, "Goal");
  assert.equal(sent.provider, "gemini");
  assert.deepEqual(sent.videos[0], { id: VID(1), title: "one", channel: "c", duration_sec: 180 });
  assert.equal(sent.videos.length, 3);

  r = await t.get(S);
  assert.equal(r.json.state, "running");
  assert.equal(r.json.pct, 25);
  assert.equal(r.json.stage, "profiling");
  assert.equal(r.json.result, undefined);

  finish(JOB(1));
  r = await t.get(S);
  assert.equal(r.json.state, "ready");
  assert.equal(r.json.pct, 100);
  assert.equal(r.json.current, true);
  assert.deepEqual(r.json.usage, USAGE);
  assert.equal(r.json.result.path_summary, "Start with the basics.");
  assert.match(r.json.generatedAt, /^\d{4}-\d\d-\d\dT/);

  const hits = w.hits;
  w.jobs.clear();                                                        // worker "restarts": the stored result still serves
  r = await t.get(S);
  assert.equal(r.json.state, "ready");
  assert.equal(r.json.result.order.length, 3);
  assert.equal(w.hits, hits);
});

test("an identical queued / running / ready run is returned (cached), no second worker job", async () => {
  await t.post(S);
  let r = await t.post(S);
  assert.equal(r.status, 200);
  assert.equal(r.json.cached, true);
  assert.equal(r.json.state, "running");

  finish(JOB(1));
  r = await t.post(S);
  assert.equal(r.status, 200);
  assert.equal(r.json.cached, true);
  assert.equal(r.json.state, "ready");
  assert.ok(r.json.result);
  assert.equal(w.created.length, 1);

  const rs = await Promise.all([1, 2, 3].map(() => t.post("/api/v1/playlists/goal/smart")));
  assert.ok(rs.every((x) => x.json.cached === true));
  assert.equal(w.created.length, 1);
});

test("concurrent first starts create one worker job", async () => {
  const rs = await Promise.all([1, 2, 3, 4].map(() => t.post(S)));
  assert.equal(w.created.length, 1);
  assert.equal(rs.filter((r) => r.status === 202).length, 1);
});

test("changing the playlist makes the stored run current:false (result still returned); a new POST starts a new run", async () => {
  await t.post(S);
  finish(JOB(1));
  assert.equal((await t.get(S)).json.current, true);

  await t.post("/api/v1/playlists/goal/videos", { id: VID(4), title: "four" });
  let r = await t.get(S);
  assert.equal(r.json.state, "ready");
  assert.equal(r.json.current, false);
  assert.ok(r.json.result);

  r = await t.post(S);
  assert.equal(r.status, 202);
  assert.equal(r.json.current, true);
  assert.equal(w.created.length, 2);
  assert.equal(w.created[1].body.videos.length, 4);

  r = await t.get(S);                                                    // the latest run is the new one
  assert.equal(r.json.state, "running");
  assert.equal(r.json.current, true);

  // renaming changes the goal, so that is a change too; reordering alone is not
  finish(JOB(2));
  await t.put("/api/v1/playlists/goal/videos/order", { order: [VID(4), VID(3), VID(2), VID(1)] });
  assert.equal((await t.get(S)).json.current, true);
  await t.patch("/api/v1/playlists/goal", { name: "Another goal" });
  assert.equal((await t.get(S)).json.current, false);
});

test("fewer than 2 or more than 20 videos -> 422, nothing is started", async () => {
  await t.post("/api/v1/playlists", { id: "one", name: "One", videos: [{ id: VID(1) }] });
  let r = await t.post("/api/v1/playlists/one/smart");
  assert.equal(r.status, 422);
  assert.match(r.json.error, /2 to 20/);

  const many = Array.from({ length: 21 }, (_, i) => ({ id: VID(100 + i) }));
  await t.post("/api/v1/playlists", { id: "many", name: "Many", videos: many });
  r = await t.post("/api/v1/playlists/many/smart");
  assert.equal(r.status, 422);
  assert.equal(w.created.length, 0);
  assert.equal((await t.get("/api/v1/playlists/one/smart")).json.state, "none");   // GET still answers
});

test("unknown playlist -> 404; bad id -> 400", async () => {
  assert.equal((await t.get("/api/v1/playlists/nope/smart")).status, 404);
  assert.equal((await t.post("/api/v1/playlists/nope/smart")).status, 404);
  assert.equal((await t.get("/api/v1/playlists/BAD_ID/smart")).status, 400);
});

test("a worker 404 turns a running run into an error 'interrupted'; a new POST works", async () => {
  await t.post(S);
  w.jobs.clear();
  let r = await t.get(S);
  assert.equal(r.json.state, "error");
  assert.match(r.json.error, /interrupted/i);
  assert.equal(r.json.result, undefined);

  r = await t.post(S);                                                   // a failed run never blocks a new one
  assert.equal(r.status, 202);
  assert.equal(r.json.state, "queued");
  assert.equal(w.created.length, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM smart_runs").get().n, 2);
});

test("a worker error is kept as an error run and does not block a retry; progress never moves backwards", async () => {
  await t.post(S);
  w.jobs.get(JOB(1)).pct = 60;
  assert.equal((await t.get(S)).json.pct, 60);
  w.jobs.get(JOB(1)).pct = 10;
  assert.equal((await t.get(S)).json.pct, 60);

  Object.assign(w.jobs.get(JOB(1)), { status: "error", error: "model overloaded" });
  let r = await t.get(S);
  assert.equal(r.json.state, "error");
  assert.equal(r.json.error, "model overloaded");

  r = await t.post(S);
  assert.equal(r.status, 202);
});

test("an oversized result is refused (error run, nothing stored)", async () => {
  await t.post(S);
  finish(JOB(1), { result: { ...RESULT([VID(1)]), checks: ["x".repeat(600 * 1024)] } });
  const r = await t.get(S);
  assert.equal(r.json.state, "error");
  assert.match(r.json.error, /too large/i);
  assert.equal(t.db.prepare("SELECT result_json FROM smart_runs").get().result_json, null);
});

test("another user cannot read or start a run on someone else's playlist", async () => {
  const two = await startApp({ fetchImpl: w.fetch, authenticate: (req, _res, next) => { req.user = { id: Number(req.headers["x-user"] || 1), name: "u" }; next(); } });
  try {
    two.db.exec("INSERT INTO users (id, name) VALUES (2, 'b')");
    const vids = [{ id: VID(1) }, { id: VID(2) }];
    await two.post("/api/v1/playlists", { id: "mine", name: "Mine", videos: vids }, { "x-user": "1" });
    await two.post(S.replace("goal", "mine"), undefined, { "x-user": "1" });
    finish(JOB(1));
    assert.equal((await two.get(S.replace("goal", "mine"), { "x-user": "1" })).json.state, "ready");

    assert.equal((await two.get(S.replace("goal", "mine"), { "x-user": "2" })).status, 404);
    assert.equal((await two.post(S.replace("goal", "mine"), undefined, { "x-user": "2" })).status, 404);
    // user 2 with a same-named playlist gets their own (empty) state, not user 1's result
    await two.post("/api/v1/playlists", { id: "mine", name: "Mine", videos: vids }, { "x-user": "2" });
    const r = await two.get(S.replace("goal", "mine"), { "x-user": "2" });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "none");
  } finally { await two.close(); }
});

test("deleting the playlist deletes its runs", async () => {
  await t.post(S);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM smart_runs").get().n, 1);
  assert.equal((await t.del("/api/v1/playlists/goal")).status, 204);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM smart_runs").get().n, 0);
});

test("worker busy -> 429 with Retry-After; worker offline -> 503 py_offline, GET keeps the stored state", async () => {
  w.busy = true;
  let r = await t.post(S);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  w.busy = false;

  w.offline = true;
  r = await t.post(S);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "py_offline");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM smart_runs").get().n, 0);

  w.offline = false;
  await t.post(S);
  w.offline = true;
  r = await t.get(S);                                                    // status refresh keeps the record
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "queued");
});
