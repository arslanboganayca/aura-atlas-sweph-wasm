import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createEphemerisHandler } from "../handler.js";

// The Worker's answers against the native `sweph` npm binding (Swiss Ephemeris 2.10.03, same .se1 files), for the
// 24 ephemeris operations a chart needs per birth: the birth Sun, the Sun crossing 88° earlier searched from 100 days
// before birth, and the 10 bodies + true node at the birth and at the design moment.
//
// Needs three local paths (nothing is fetched):
//   SWEPH_NATIVE    the native binding's package folder (node_modules/sweph)
//   CHART_FIXTURES  a JSON array of { request: { birth: { local, timeZone } } } (synthetic births)
//   CIVIL_TIME      an ES module exporting localCivilToEpochMs(local, timeZone) (local civil time → epoch ms)
// Without them the test is skipped.
const { SWEPH_NATIVE, CHART_FIXTURES, CIVIL_TIME } = process.env;
const configured = Boolean(SWEPH_NATIVE && CHART_FIXTURES && CIVIL_TIME);

const SEFLG_SWIEPH = 2, SEFLG_SPEED = 256, FLAGS = SEFLG_SWIEPH | SEFLG_SPEED;
const BODIES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11]; // Sun … Pluto, true node
const julianDay = (ms) => ms / 86400000 + 2440587.5;

test("the Worker equals native Swiss Ephemeris for the 24 chart operations of every fixture birth",
  { skip: configured ? false : "set SWEPH_NATIVE, CHART_FIXTURES and CIVIL_TIME", timeout: 120_000 }, async () => {
    const sweph = createRequire(import.meta.url)(SWEPH_NATIVE);
    sweph.set_ephe_path(fileURLToPath(new URL("../ephe", import.meta.url)));
    assert.equal(sweph.version(), "2.10.03");
    const { localCivilToEpochMs } = await import(pathToFileURL(CIVIL_TIME).href);
    const fixtures = JSON.parse(readFileSync(CHART_FIXTURES, "utf8"));
    const handle = createEphemerisHandler(new WebAssembly.Module(readFileSync(new URL("../dist/sweph.wasm", import.meta.url))));
    const ask = async (ops) => {
      const response = await handle(new Request("https://sweph.internal/", { method: "POST", body: JSON.stringify({ ops }) }));
      assert.equal(response.status, 200);
      return (await response.json()).results;
    };
    // The WebAssembly and native builds of the same C sources round the last bits differently (compiler and FPU), so
    // doubles are compared with bounds far below a chart's finest unit (a base is 0.0052° of longitude); flags and
    // error texts exactly. Bounds per value: longitude, latitude (°), distance (AU), their daily speeds; Julian day.
    const BOUNDS = [1e-7, 1e-7, 1e-9, 1e-5, 1e-5, 1e-6];
    const DATE_BOUND = 1e-8; // days (< 1 ms)
    const largest = Array(7).fill(0);
    let identicalValues = 0, values = 0;
    const close = (a, b, slot, bound) => {
      values++;
      if (Object.is(a, b)) identicalValues++;
      if (typeof a !== "number" || typeof b !== "number") return false;
      largest[slot] = Math.max(largest[slot], Math.abs(a - b));
      return Math.abs(a - b) <= bound;
    };
    const sameCalc = (worker, native) => worker.flag === native.flag && worker.error === native.error
      && worker.data.length === 6 && worker.data.map((value, i) => close(value, native.data[i], i, BOUNDS[i])).every(Boolean);

    let births = 0, operations = 0;
    const different = [];
    for (const [index, fixture] of fixtures.entries()) {
      const { local, timeZone } = fixture.request.birth;
      const epochMs = localCivilToEpochMs({ ...local, second: 0 }, timeZone);
      assert.ok(Number.isFinite(epochMs), "fixture " + index + " has a civil time");
      const birthJd = julianDay(epochMs);

      // Round 1: the birth Sun (the same call as the birth Sun of the 11 bodies).
      const [birthSun] = await ask([{ op: "calc", jd: birthJd, body: 0, flags: FLAGS }]);
      const nativeBirthSun = sweph.calc_ut(birthJd, 0, FLAGS);
      if (!sameCalc(birthSun, nativeBirthSun)) different.push(index + ":birth-sun");
      // Round 2: the design moment.
      const target = (((nativeBirthSun.data[0] - 88) % 360) + 360) % 360;
      const [crossing] = await ask([{ op: "solcross", x: target, jd: birthJd - 100, flags: SEFLG_SWIEPH }]);
      const nativeCrossing = sweph.solcross_ut(target, birthJd - 100, SEFLG_SWIEPH);
      if (!(close(crossing.date, nativeCrossing.date, 6, DATE_BOUND) && crossing.error === nativeCrossing.error)) different.push(index + ":solcross");
      // The chart takes the design moment as a Date (whole milliseconds): both builds must give the same one.
      const designMs = (date) => new Date((date - 2440587.5) * 86400000).getTime();
      if (designMs(crossing.date) !== designMs(nativeCrossing.date)) different.push(index + ":design-ms");
      const designJd = julianDay(designMs(nativeCrossing.date));
      // Round 3: 11 bodies at both moments.
      const moments = [birthJd, designJd];
      const ops = moments.flatMap((jd) => BODIES.map((body) => ({ op: "calc", jd, body, flags: FLAGS })));
      const results = await ask(ops);
      ops.forEach((op, i) => {
        if (!sameCalc(results[i], sweph.calc_ut(op.jd, op.body, op.flags))) different.push(`${index}:${op.jd === birthJd ? "birth" : "design"}:${op.body}`);
      });
      births++;
      operations += 2 + ops.length;
    }
    assert.equal(operations, births * 24);
    assert.deepEqual(different, [], "every flag, error text and design millisecond identical, every double within its bound");
    console.log(`native parity: ${births} births, ${operations} operations, ${different.length} different; `
      + `${identicalValues}/${values} doubles bit-identical; largest differences `
      + `lon ${largest[0].toExponential(1)}° lat ${largest[1].toExponential(1)}° dist ${largest[2].toExponential(1)} AU `
      + `speeds ${largest.slice(3, 6).map((v) => v.toExponential(1)).join("/")} per day, solcross ${largest[6].toExponential(1)} d`);
  });
