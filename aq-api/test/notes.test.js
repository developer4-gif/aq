import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, startMockPython, VID, JOB } from "./helpers.js";

let py, t;
beforeEach(async () => {
  py = await startMockPython();
  t = await startApp({ py });
  await t.post("/api/v1/playlists", { name: "L", videos: [{ id: VID(1), title: "one" }, { id: VID(2), title: "two" }] });
});
afterEach(async () => { await t.close(); await py.close(); });

const N = "/api/v1/notes";

test("status is 'none' for an unknown video; ids are validated", async () => {
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "none");
  assert.equal((await t.get(`${N}/bad`)).status, 400);
  assert.equal((await t.post(`${N}/bad`)).status, 400);
  assert.equal((await t.get(`${N}/${VID(1)}/html`)).status, 404);        // nothing ready yet
});

test("start creates exactly one Python job per video (running jobs are shared)", async () => {
  let r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 202);
  assert.equal(r.json.state, "queued");
  assert.equal(r.json.jobId, JOB(1));
  assert.equal(py.state.jobsCreated[0].body.url, `https://www.youtube.com/watch?v=${VID(1)}`);
  assert.equal(py.state.jobsCreated[0].body.provider, "groq");

  r = await t.post(`${N}/${VID(1)}`);                                    // again while running
  assert.equal(r.status, 200);
  assert.equal(r.json.cached, true);
  assert.equal(r.json.state, "running");
  assert.equal(r.json.pct, 40);
  assert.equal(py.state.jobsCreated.length, 1);
});

test("concurrent starts of the same video create one job", async () => {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => t.post(`${N}/${VID(2)}`)));
  assert.equal(py.state.jobsCreated.length, 1);
  assert.equal(rs.filter((r) => r.status === 202).length, 1);
  assert.ok(rs.every((r) => r.json.jobId === JOB(1)));
});

test("ready notes are cached: start returns immediately without a new job; html and pdf stream through", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.get(JOB(1)).status = "done";
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "ready");
  assert.equal(r.json.pct, 100);

  r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "ready");
  assert.equal(r.json.cached, true);
  assert.equal(py.state.jobsCreated.length, 1);

  r = await t.get(`${N}/${VID(1)}/html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(r.text, "<h1>notes</h1>");
  r = await t.get(`${N}/${VID(1)}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /attachment/);

  r = await t.get(N);                                                    // list of live records
  assert.deepEqual(r.json.notes.map((x) => [x.videoId, x.state]), [[VID(1), "ready"]]);
});

test("another user gets the same cached notes (one job per video across users)", async () => {
  const two = await startApp({ py, authenticate: (req, _res, next) => { req.user = { id: Number(req.headers["x-user"] || 1), name: "u" }; next(); } });
  try {
    two.db.exec("INSERT INTO users (id, name) VALUES (2, 'b')");
    await two.post("/api/v1/playlists", { name: "P1", videos: [{ id: VID(5) }] }, { "x-user": "1" });
    await two.post("/api/v1/playlists", { name: "P2", videos: [{ id: VID(5) }] }, { "x-user": "2" });
    const a = await two.post(`${N}/${VID(5)}`, undefined, { "x-user": "1" });
    py.state.jobs.get(a.json.jobId).status = "done";
    const b = await two.post(`${N}/${VID(5)}`, undefined, { "x-user": "2" });
    assert.equal(b.json.state, "ready");
    assert.equal(b.json.cached, true);
    assert.equal(py.state.jobsCreated.filter((j) => j.body.url.endsWith(VID(5))).length, 1);
  } finally { await two.close(); }
});

test("error jobs allow a new start; progress never moves backwards", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.get(JOB(1)).pct = 70;
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.pct, 70);
  py.state.jobs.get(JOB(1)).pct = 30;
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.pct, 70);

  Object.assign(py.state.jobs.get(JOB(1)), { status: "error", error: "boom" });
  let r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.json.state, "error");
  assert.equal(r.json.error, "boom");
  assert.equal((await t.get(N)).json.notes.length, 0);

  r = await t.post(`${N}/${VID(1)}`);                                    // retry
  assert.equal(r.status, 202);
  assert.equal(r.json.jobId, JOB(2));
  assert.equal(py.state.jobsCreated.length, 2);
});

test("a Python restart (job 404) expires the record and a new start works", async () => {
  await t.post(`${N}/${VID(1)}`);
  py.state.jobs.get(JOB(1)).status = "done";
  assert.equal((await t.get(`${N}/${VID(1)}`)).json.state, "ready");

  py.state.jobs.clear();                                                 // "restart": files and jobs are gone
  let r = await t.get(`${N}/${VID(1)}`);                                 // verify() sees a 404 on HEAD
  assert.equal(r.json.state, "none");
  assert.match(r.json.message, /expired/i);
  assert.equal((await t.get(`${N}/${VID(1)}/html`)).status, 404);

  r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 202);
  assert.equal(py.state.jobsCreated.length, 2);
});

test("permission: notes can only be started for videos in the user's playlists", async () => {
  const r = await t.post(`${N}/${VID(9)}`);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "not_in_playlist");
  assert.equal(py.state.jobsCreated.length, 0);
});

test("Python busy -> 429 with Retry-After; Python rejects -> 422; Python down -> 503", async () => {
  py.state.busy = true;
  let r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  py.state.busy = false;

  py.state.rejectWith = "No Groq key configured";
  r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "No Groq key configured");
  py.state.rejectWith = null;
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notes_jobs").get().n, 0);

  await py.close();
  r = await t.post(`${N}/${VID(1)}`);
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "py_offline");
  r = await t.get(`${N}/${VID(1)}`);                                     // status itself still answers
  assert.equal(r.status, 200);
  py = await startMockPython();                                          // so afterEach can close something
});

test("status refresh keeps the record when Python is unreachable", async () => {
  await t.post(`${N}/${VID(1)}`);
  await py.close();
  const r = await t.get(`${N}/${VID(1)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "queued");
  py = await startMockPython();
});

test("import/youtube forwards only the validated list id", async () => {
  let r = await t.get("/api/v1/import/youtube?url=" + encodeURIComponent("https://www.youtube.com/playlist?list=PLabcdefghij&evil=http://169.254.169.254/"));
  assert.equal(r.status, 200);
  assert.equal(r.json.videos.length, 1);
  assert.equal(py.state.playlistUrls[0], "https://www.youtube.com/playlist?list=PLabcdefghij");
  assert.equal((await t.get("/api/v1/import/youtube")).status, 400);
  assert.equal((await t.get("/api/v1/import/youtube?url=" + encodeURIComponent("https://youtube.com/watch?v=abc"))).status, 400);
  assert.equal((await t.get("/api/v1/import/youtube?url=" + encodeURIComponent("x".repeat(3000)))).status, 400);
});

test("fonts for the notes page come from Python; other font paths are refused", async () => {
  assert.equal((await t.get("/static/fonts/Caveat.woff2")).status, 200);
  assert.equal((await t.get("/static/fonts/..%2Fsecret")).status, 404);
});
