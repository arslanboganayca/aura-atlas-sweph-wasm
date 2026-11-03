import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEphemerisHandler, MAX_OPS } from "../handler.js";

// The handler in Node, with the same compiled module the Worker gets. Synthetic Julian days only.
const wasm = new WebAssembly.Module(readFileSync(new URL("../dist/sweph.wasm", import.meta.url)));
const handle = createEphemerisHandler(wasm);
const post = (body, init = {}) => handle(new Request("https://sweph.internal/", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init,
}));
const SEFLG_SWIEPH = 2, SEFLG_SPEED = 256, FLAGS = SEFLG_SWIEPH | SEFLG_SPEED;

test("version answers the Swiss Ephemeris library version", async () => {
  const response = await post({ ops: [{ op: "version" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { results: [{ version: "2.10.03" }] });
});

test("calc and solcross answer the library's raw results", async () => {
  const response = await post({ ops: [
    { op: "calc", jd: 2451545, body: 0, flags: FLAGS },
    { op: "solcross", x: 100, jd: 2451545, flags: SEFLG_SWIEPH },
  ] });
  const { results } = await response.json();
  assert.equal(results.length, 2);
  assert.ok(results[0].flag >= 0 && (results[0].flag & SEFLG_SWIEPH) !== 0);
  assert.equal(results[0].error, "");
  assert.equal(results[0].data.length, 6);
  assert.ok(results[0].data.every(Number.isFinite));
  assert.ok(results[0].data[0] > 279 && results[0].data[0] < 281, "the Sun near 280° on 2000-01-01");
  assert.ok(results[1].date > 2451545 && results[1].date < 2451545 + 366);
  assert.equal(results[1].error, "");
});

test("library errors are returned as the library reports them, never interpreted", async () => {
  const { results } = await (await post({ ops: [
    { op: "calc", jd: 2451545, body: 9999, flags: FLAGS },
    { op: "calc", jd: 2_000_000, body: 0, flags: FLAGS },
    { op: "solcross", x: 100, jd: 1_000_000, flags: SEFLG_SWIEPH },
  ] })).json();
  assert.ok(results[0].flag < 0 && results[0].error !== "");
  assert.equal(results[1].flag & SEFLG_SWIEPH, 0, "outside the .se1 range the library falls back; the caller refuses it");
  assert.ok(results[2].error !== "" || !(results[2].date > 1_000_000));
});

test("strict input: anything else is 400 bad_request", async () => {
  const bad = [
    "not json", "{}", "[]", "null",
    { ops: [] },
    { ops: Array.from({ length: MAX_OPS + 1 }, () => ({ op: "version" })) },
    { ops: [{ op: "calc", jd: "2451545", body: 0, flags: FLAGS }] },
    { ops: [{ op: "calc", jd: 2451545, body: 0.5, flags: FLAGS }] },
    { ops: [{ op: "calc", jd: 2451545, body: 0, flags: 2 ** 40 }] },
    { ops: [{ op: "calc", jd: 2451545, body: 0 }] },
    { ops: [{ op: "calc", jd: 2451545, body: 0, flags: FLAGS, extra: 1 }] },
    { ops: [{ op: "solcross", x: 100, jd: 2451545, flags: 2.5 }] },
    { ops: [{ op: "solcross", x: null, jd: 2451545, flags: 2 }] },
    { ops: [{ op: "houses" }] },
    { ops: [{ op: "version", x: 1 }] },
    { ops: [{ op: "version" }], other: true },
    JSON.stringify({ ops: [{ op: "version" }] }).replace("}]", ', "pad": "' + "x".repeat(20_000) + '"}]'),
  ];
  for (const body of bad) {
    const response = await post(body);
    assert.equal(response.status, 400, typeof body === "string" ? body.slice(0, 40) : JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await response.json(), { error: "bad_request" });
  }
  // JSON cannot carry Infinity or NaN; a 1e999 literal parses to Infinity and is refused.
  assert.equal((await post('{"ops":[{"op":"calc","jd":1e999,"body":0,"flags":258}]}')).status, 400);
  assert.equal((await handle(new Request("https://sweph.internal/", { method: "GET" }))).status, 405);
});

test("64 operations in one request are accepted", async () => {
  const ops = Array.from({ length: MAX_OPS }, (_, i) => ({ op: "calc", jd: 2451545 + i, body: i % 10, flags: FLAGS }));
  const { results } = await (await post({ ops })).json();
  assert.equal(results.length, MAX_OPS);
});

test("the handler never writes to the console", async (t) => {
  const calls = [];
  for (const name of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, name, (...args) => calls.push(args));
  await post({ ops: [{ op: "calc", jd: 2451545, body: 9999, flags: FLAGS }, { op: "version" }] });
  await post("garbage");
  assert.deepEqual(calls, []);
});
