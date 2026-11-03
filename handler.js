// The request handler of the ephemeris Worker, kept apart from worker.js so it can also run in Node (tests) with the
// WebAssembly module handed in. It answers raw Swiss Ephemeris results only: nothing is interpreted, stored or logged.
import createSweph from "./dist/sweph.mjs";

export const MAX_OPS = 64;
export const MAX_BODY_BYTES = 16 * 1024;
const ERROR_BYTES = 256; // AS_MAXCH: the library's error text buffer
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * The Emscripten glue (built with ENVIRONMENT=web,worker,node) takes its Node branch whenever `process.versions.node`
 * is set, which workerd also sets under nodejs_compat; that branch needs node:module, which a Worker does not have.
 * The environment is detected once, synchronously, at the very start of createSweph, so `process` is hidden for exactly
 * that synchronous call and restored before anything else can run. With instantiateWasm supplied, the glue never reads
 * a file or fetches a URL. A rebuild with ENVIRONMENT=web,worker (see build.sh) would make this unnecessary.
 */
function instantiate(wasmModule) {
  return new Promise((resolve, reject) => {
    const scope = globalThis;
    const savedProcess = scope.process;
    let pending;
    try {
      scope.process = undefined;
      pending = createSweph({
        instantiateWasm(imports, done) {
          WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance), reject);
          return {};
        },
        // Nothing from the library reaches a log.
        print: () => {},
        printErr: () => {},
      });
    } finally {
      scope.process = savedProcess;
    }
    pending.then(resolve, reject);
  });
}

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isInt32 = (value) => Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** One operation, checked strictly: the exact keys, finite numbers, 32-bit integers for body and flags. */
function isOperation(op) {
  if (!isPlainObject(op)) return false;
  switch (op.op) {
    case "calc":
      return hasOnlyKeys(op, ["op", "jd", "body", "flags"]) && isFiniteNumber(op.jd) && isInt32(op.body) && isInt32(op.flags);
    case "solcross":
      return hasOnlyKeys(op, ["op", "x", "jd", "flags"]) && isFiniteNumber(op.x) && isFiniteNumber(op.jd) && isInt32(op.flags);
    case "version":
      return hasOnlyKeys(op, ["op"]);
    default:
      return false;
  }
}

/** `{ ops: [...] }` with 1..MAX_OPS valid operations, or null. */
export function parseOperations(body) {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["ops"]) || !Array.isArray(body.ops)) return null;
  if (body.ops.length === 0 || body.ops.length > MAX_OPS) return null;
  return body.ops.every(isOperation) ? body.ops : null;
}

/** A non-finite double cannot travel as JSON; it is sent as null and the caller's guards refuse it. */
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

function runner(module) {
  const out = module._malloc(6 * 8);
  const err = module._malloc(ERROR_BYTES);
  const clearError = () => new Uint8Array(module.HEAPF64.buffer, err, ERROR_BYTES).fill(0);
  return (op) => {
    clearError();
    if (op.op === "calc") {
      const flag = module._aa_calc_ut(op.jd, op.body, op.flags, out, err);
      const base = out / 8;
      const data = Array.from(module.HEAPF64.subarray(base, base + 6), finiteOrNull);
      return { flag, error: module.UTF8ToString(err), data };
    }
    if (op.op === "solcross") {
      const date = module._aa_solcross_ut(op.x, op.jd, op.flags, err);
      return { date: finiteOrNull(date), error: module.UTF8ToString(err) };
    }
    module._aa_version(err);
    return { version: module.UTF8ToString(err) };
  };
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function readBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Returns `fetch(request)`. The module is instantiated once, on the first request; a failed attempt is forgotten so
 * the next request tries again. Calls run synchronously one after another, so concurrent requests cannot interleave
 * inside the shared buffers.
 */
export function createEphemerisHandler(wasmModule) {
  let run = null;
  let loading = null;
  const ready = () => {
    if (run) return Promise.resolve(run);
    loading ??= instantiate(wasmModule).then((module) => (run = runner(module))).catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  };

  return async function fetch(request) {
    if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
    const ops = parseOperations(await readBody(request));
    if (ops === null) return jsonResponse(400, { error: "bad_request" });
    let calculate;
    try {
      calculate = await ready();
    } catch {
      return jsonResponse(503, { error: "unavailable" });
    }
    return jsonResponse(200, { results: ops.map(calculate) });
  };
}
