# aura-atlas-sweph-wasm

Swiss Ephemeris 2.10.03 compiled to WebAssembly and run as a small Cloudflare Worker, `aura-atlas-sweph`. It is the
planet-position calculator behind the chart on [auraatlas.co](https://auraatlas.co): the website's own Worker asks it
for numbers over a Cloudflare service binding and builds the chart from them.

Swiss Ephemeris © Astrodienst AG, Zürich, Switzerland, used under the GNU Affero General Public License v3
(AGPL-3.0). This whole repository — the Swiss Ephemeris sources and data files, `glue.c`, `build.sh`, the built
`dist/` files, `handler.js`, `worker.js` and the tests — is distributed under the AGPL-3.0; see `LICENSE`.

## What it does, and what it does not

It answers exactly what two Swiss Ephemeris functions return, nothing interpreted:

- `swe_calc_ut` — the position of one body at one moment (longitude, latitude, distance and their daily speeds),
- `swe_solcross_ut` — the moment the Sun next reaches a given ecliptic longitude,

plus `swe_version`. It receives only Julian day numbers, body numbers, flags and longitudes — no name, birth place,
account or other personal data — and it stores nothing, keeps no state between requests other than the loaded
WebAssembly module, and writes nothing to any log.

## Request and answer

`POST` with a JSON body of at most 16 KiB and 1–64 operations:

```json
{ "ops": [
  { "op": "calc", "jd": 2451545.0, "body": 0, "flags": 258 },
  { "op": "solcross", "x": 100.0, "jd": 2451545.0, "flags": 2 },
  { "op": "version" }
] }
```

The answer has one result per operation, in order:

```json
{ "results": [
  { "flag": 258, "error": "", "data": [280.3689186698997, 0.0002273534758712041, 0.9833276253625055,
      1.0194341629435535, -5.876111779464568e-7, -0.0000073507779749972415] },
  { "date": 2451727.0587066924, "error": "" },
  { "version": "2.10.03" }
] }
```

- `calc`: `flag` is `swe_calc_ut`'s return value (negative on error), `error` its error text, `data` its six doubles.
- `solcross`: `date` is `swe_solcross_ut`'s Julian day (UT), `error` its error text.
- A non-finite double cannot be written as JSON and is sent as `null`.
- The caller judges the answer (a negative flag, a result without `SEFLG_SWIEPH`, an error text): the Worker never
  substitutes or corrects anything.

Input is checked strictly: `jd` and `x` must be finite numbers, `body` and `flags` 32-bit integers, each operation must
have exactly its own keys, and there must be 1–64 operations. Anything else is `400 {"error":"bad_request"}`; a method
other than `POST` is `405`; a module that cannot be loaded is `503 {"error":"unavailable"}`.

## Files

| Path | What it is |
|---|---|
| `src/` | The official Swiss Ephemeris 2.10.03 C sources, unchanged. |
| `ephe/` | The Swiss Ephemeris data files `seas_18.se1`, `semo_18.se1`, `sepl_18.se1` (1800–2399), unchanged. |
| `glue.c` | Exposes `swe_calc_ut`, `swe_solcross_ut` and `swe_version` to JavaScript, unchanged. Ephemeris path `/ephe`. |
| `build.sh` | Builds `src/` + `glue.c` with Emscripten into `dist/`, embedding `ephe/` at `/ephe`. |
| `dist/sweph.mjs`, `dist/sweph.wasm` | The build output the Worker runs. |
| `handler.js` | The request handler: validation, one module per isolate, the raw results. |
| `worker.js` | The Worker entry: hands the compiled `dist/sweph.wasm` to the handler. |
| `wrangler.jsonc` | Worker `aura-atlas-sweph`; `workers_dev: false`, no routes, no preview URLs. |
| `test/` | Handler tests and the native parity test. |

| File | Bytes | sha256 |
|---|---|---|
| `dist/sweph.wasm` | 2,367,236 | `3a3d4e6f54b29e26c9684f8a220c792fe1746c110a7f600032dfd2e8b382e5a9` |
| `dist/sweph.mjs` | 58,665 | `fdbb9e9b2ca627bfafe2464d7c3c4dd2f2ab2932db19cf7a720e71425ed8b404` |
| `ephe/seas_18.se1` | 223,004 | `a2cd8fc33807c78ca9a700c91c2e042258b12fc4796519e00781440b5ad8b2e2` |
| `ephe/semo_18.se1` | 1,304,771 | `1ca07bd67c24374d77226180c20a4f9996cba013697894810518e7eb582ca4f7` |
| `ephe/sepl_18.se1` | 484,061 | `ca1393ceab3a44fbc895887cf789c68819ae6a1cbc9b22225872dbe4ccd99a66` |

## Build

Needs [Emscripten](https://emscripten.org) on `PATH` (`source <emsdk>/emsdk_env.sh`):

```
./build.sh
```

The published `dist/` was built with `-sENVIRONMENT=web,worker,node` (the default of `build.sh`). That glue takes its
Node branch whenever `process.versions.node` is set — which a Worker with `nodejs_compat` also sets — so `handler.js`
hides `process` for the one synchronous call in which the glue detects its environment. `SWEPH_ENVIRONMENT=web,worker
./build.sh` builds a glue without the Node branch, which makes that workaround unnecessary; such a build is a different
`dist/` and must pass the native parity test below before it is deployed.

## Test

```
node --test test/*.test.mjs
```

`test/handler.test.mjs` runs the handler in Node with `dist/sweph.wasm`. `test/native-parity.test.mjs` compares it with
the native [`sweph`](https://github.com/timotejroiko/sweph) npm binding (2.10.3-7, same `.se1` files) for the 24
ephemeris operations a chart needs per birth; it needs three local paths and is skipped without them:

```
SWEPH_NATIVE=<node_modules/sweph> CHART_FIXTURES=<births.json> CIVIL_TIME=<module exporting localCivilToEpochMs> \
  node --test test/*.test.mjs
```

Over 300 synthetic births (7,200 operations) every flag and error text is identical; the WebAssembly and native builds
round the last bits differently, the largest difference being 6.6e-9° of longitude (a chart's finest unit is 0.0052°),
and every design moment is the same to the millisecond.

## Deploy

Deployed by the Aura Atlas maintainers to their own Cloudflare account, before the website Worker that binds to it:

```
npx wrangler deploy --env test   # aura-atlas-sweph-test, for the TEST website
npx wrangler deploy --env=""     # aura-atlas-sweph, for auraatlas.co
```

The website reaches it through a service binding (`services: [{ binding: "SWEPH", service: "aura-atlas-sweph" }]`, `aura-atlas-sweph-test` for the TEST website) and
checks `swe_version` on every chart.
