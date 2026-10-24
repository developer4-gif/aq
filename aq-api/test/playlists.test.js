import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID } from "./helpers.js";

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const P = "/api/v1/playlists";
const v = (n, extra = {}) => ({ id: VID(n), title: "Video " + n, channel: "Chan", duration: "1:30", ...extra });

test("playlist CRUD", async () => {
  let r = await t.post(P, { name: "Data Science", description: "math" });
  assert.equal(r.status, 201);
  assert.equal(r.json.playlist.id, "data-science");
  assert.equal(r.json.playlist.videoCount, 0);

  r = await t.get(P);
  assert.deepEqual(r.json.playlists.map((p) => p.id), ["data-science"]);
  assert.equal(r.json.playlists[0].videos, undefined);

  r = await t.patch(P + "/data-science", { name: "DS 2", description: "new" });
  assert.equal(r.status, 200);
  assert.equal(r.json.playlist.name, "DS 2");
  assert.equal(r.json.playlist.id, "data-science");           // id is stable across renames

  r = await t.patch(P + "/data-science", { description: "only desc" });
  assert.equal(r.json.playlist.name, "DS 2");
  assert.equal(r.json.playlist.description, "only desc");

  r = await t.del(P + "/data-science");
  assert.equal(r.status, 204);
  assert.equal((await t.get(P + "/data-science")).status, 404);
  assert.equal((await t.del(P + "/data-science")).status, 404);
});

test("playlist validation: names, ids, duplicates, bad bodies", async () => {
  assert.equal((await t.post(P, { name: "" })).status, 400);
  assert.equal((await t.post(P, { name: "   " })).status, 400);
  assert.equal((await t.post(P, { name: "x".repeat(61) })).status, 400);
  assert.equal((await t.post(P, { name: "ok", description: "d".repeat(161) })).status, 400);
  assert.equal((await t.post(P, { name: 5 })).status, 400);
  assert.equal((await t.post(P, "not json")).status, 400);
  assert.equal((await t.post(P, [1, 2])).status, 400);
  assert.equal((await t.post(P, { name: "bad", id: "Bad Id!" })).status, 400);
  assert.equal((await t.post(P, { name: "ok", source: { type: "youtube", listId: "x" } })).status, 400);
  assert.equal((await t.post(P, { name: "Dup" })).status, 201);
  const d = await t.post(P, { name: "dup" });                  // case-insensitive
  assert.equal(d.status, 409);
  assert.equal((await t.get(P + "/Not_A_Slug")).status, 400);
  assert.equal((await t.get(P + "/missing")).status, 404);
  assert.equal((await t.patch(P + "/dup", {})).status, 400);
  await t.post(P, { name: "Other" });
  assert.equal((await t.patch(P + "/other", { name: "DUP" })).status, 409);
  await t.del(P + "/dup"); await t.del(P + "/other");
});

test("same name gets distinct slugs; client-chosen id is honoured; SQL text is stored literally", async () => {
  const a = await t.post(P, { name: "Same!", id: "my-id" });
  assert.equal(a.json.playlist.id, "my-id");
  const evil = "x'); DROP TABLE playlists;--";
  const b = await t.post(P, { name: evil });
  assert.equal(b.status, 201);
  assert.equal(b.json.playlist.name, evil);
  assert.equal(b.json.playlist.id, "x-drop-table-playlists");
  assert.equal((await t.get(P)).json.playlists.length >= 2, true);
  await t.del(P + "/my-id"); await t.del(P + "/x-drop-table-playlists");
});

test("videos: add, duplicates, batch, edit, remove, reorder", async () => {
  await t.post(P, { name: "Vids" });
  const base = P + "/vids/videos";

  let r = await t.post(base, v(1));
  assert.equal(r.status, 201);
  assert.equal(r.json.video.durationSec, 90);
  assert.equal(r.json.video.duration, "1:30");
  assert.equal((await t.post(base, v(1))).status, 409);                    // duplicate in the playlist
  assert.equal((await t.post(base, { id: "short" })).status, 400);          // bad id
  assert.equal((await t.post(base, { id: "../../etc/pw" })).status, 400);
  assert.equal((await t.post(P + "/nope/videos", v(2))).status, 404);

  r = await t.post(base, { videos: [v(2), v(3), v(1), { id: "bad" }, v(4, { duration: "nonsense" })] });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, 3);
  assert.equal(r.json.skipped, 2);                                         // duplicate + invalid
  assert.equal((await t.post(base, { videos: "x" })).status, 400);
  assert.equal((await t.post(base, { videos: Array.from({ length: 501 }, (_, i) => v(i + 10)) })).status, 400);

  r = await t.get(P + "/vids");
  assert.deepEqual(r.json.playlist.videos.map((x) => x.id), [VID(1), VID(2), VID(3), VID(4)]);
  assert.deepEqual(r.json.playlist.videos.map((x) => x.position), [0, 1, 2, 3]);
  assert.equal(r.json.playlist.videoCount, 4);
  assert.equal(r.json.playlist.videos[3].durationSec, 0);

  // edit
  r = await t.patch(`${base}/${VID(2)}`, { title: "New title", channel: "Ch", duration: "1:02:03" });
  assert.equal(r.status, 200);
  assert.equal(r.json.video.title, "New title");
  assert.equal(r.json.video.durationSec, 3723);
  assert.equal((await t.patch(`${base}/${VID(9)}`, { title: "x" })).status, 404);

  // move one video with position
  r = await t.patch(`${base}/${VID(4)}`, { position: 0 });
  assert.equal(r.json.video.position, 0);
  assert.deepEqual((await t.get(P + "/vids")).json.playlist.videos.map((x) => x.id), [VID(4), VID(1), VID(2), VID(3)]);

  // reorder
  r = await t.put(base + "/order", { order: [VID(3), VID(2), VID(1), VID(4)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.playlist.videos.map((x) => x.id), [VID(3), VID(2), VID(1), VID(4)]);
  assert.equal((await t.put(base + "/order", { order: [VID(3), VID(2)] })).status, 400);                      // missing ones
  assert.equal((await t.put(base + "/order", { order: [VID(3), VID(3), VID(1), VID(4)] })).status, 400);       // repeated
  assert.equal((await t.put(base + "/order", { order: [VID(3), VID(2), VID(1), VID(8)] })).status, 400);       // stranger
  assert.equal((await t.put(base + "/order", {})).status, 400);

  // remove keeps positions contiguous
  assert.equal((await t.del(`${base}/${VID(2)}`)).status, 204);
  assert.equal((await t.del(`${base}/${VID(2)}`)).status, 404);
  r = await t.get(P + "/vids");
  assert.deepEqual(r.json.playlist.videos.map((x) => [x.id, x.position]), [[VID(3), 0], [VID(1), 1], [VID(4), 2]]);

  // listing with videos
  r = await t.get(P + "?include=videos");
  assert.equal(r.json.playlists.find((p) => p.id === "vids").videos.length, 3);
  // deleting the playlist removes its entries
  await t.del(P + "/vids");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM playlist_videos").get().n, 0);
});

test("create with videos + source (batch create) and uniqueness of insertions", async () => {
  const r = await t.post(P, {
    name: "Imported", videos: [v(1), v(1), v(2), { id: "bad" }], source: { type: "youtube", listId: "PLabcdefghij" }
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.added, 2);
  assert.equal(r.json.skipped, 2);
  assert.equal(r.json.playlist.source.url, "https://www.youtube.com/playlist?list=PLabcdefghij");
  await t.del(P + "/imported");
});

test("users cannot see or change each other's playlists and progress", async () => {
  const other = await startApp({ authenticate: (req, _res, next) => { req.user = { id: Number(req.headers["x-user"] || 1), name: "u" }; next(); } });
  try {
    other.db.exec("INSERT INTO users (id, name) VALUES (2, 'second')");
    const h1 = { "x-user": "1" }, h2 = { "x-user": "2" };
    assert.equal((await other.post(P, { name: "Mine" }, h1)).status, 201);
    assert.equal((await other.post(P, { name: "Mine" }, h2)).status, 201);          // same name is fine for another user
    await other.post(P + "/mine/videos", v(1), h1);
    assert.equal((await other.get(P + "/mine", h2)).json.playlist.videoCount, 0);
    assert.equal((await other.del(`${P}/mine/videos/${VID(1)}`, h2)).status, 404);
    assert.equal((await other.get(P + "/mine", h1)).json.playlist.videoCount, 1);
    await other.put("/api/v1/progress/" + VID(1), { pos: 5, dur: 10 }, h1);
    assert.deepEqual((await other.get("/api/v1/progress", h2)).json.progress, {});
    assert.equal((await other.get("/api/v1/progress/" + VID(1), h2)).status, 404);
  } finally { await other.close(); }
});

test("sync import: merge, replace, lenient cleanup, bootstrapped flag", async () => {
  const s = await startApp();
  try {
    assert.equal((await s.get("/api/v1/me")).json.bootstrapped, false);
    const payload = {
      mode: "merge",
      playlists: [
        { id: "a", name: "A", description: "d", created: "2024-01-01T00:00:00Z", videos: [v(1), v(2), v(2), { id: "bad" }] },
        { id: "b", name: "a" },                         // same name as A (case-insensitive) -> renamed
        { id: "BAD ID", name: "x" }, { id: "c", name: "" }, "junk"
      ],
      progress: { [VID(1)]: { pos: 20, dur: 100, done: false, updated: 1000 }, bad: { pos: 1 }, [VID(2)]: { pos: -5 } }
    };
    let r = await s.post("/api/v1/sync/import", payload);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.playlists.map((p) => p.id), ["a", "b"]);
    assert.equal(r.json.playlists[1].name, "a (2)");
    assert.equal(r.json.playlists[0].videos.length, 2);
    assert.equal(r.json.playlists[0].created, "2024-01-01T00:00:00.000Z");
    assert.deepEqual(Object.keys(r.json.progress), [VID(1)]);
    assert.equal((await s.get("/api/v1/me")).json.bootstrapped, true);

    // older progress does not overwrite newer
    r = await s.post("/api/v1/sync/import", { mode: "merge", playlists: [], progress: { [VID(1)]: { pos: 1, dur: 100, updated: 500 } } });
    assert.equal(r.json.progress[VID(1)].pos, 20);

    // replace: playlist b disappears, a takes the client's video order
    r = await s.post("/api/v1/sync/import", { mode: "replace", playlists: [{ id: "a", name: "A", videos: [v(2), v(1), v(3)] }] });
    assert.deepEqual(r.json.playlists.map((p) => p.id), ["a"]);
    assert.deepEqual(r.json.playlists[0].videos.map((x) => x.id), [VID(2), VID(1), VID(3)]);

    assert.equal((await s.post("/api/v1/sync/import", [])).status, 400);
    assert.equal((await s.post("/api/v1/sync/import", { playlists: Array.from({ length: 201 }, (_, i) => ({ id: "p" + i, name: "n" + i })) })).status, 400);
  } finally { await s.close(); }
});
