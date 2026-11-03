// Cloudflare Worker entry. The .wasm import is a Workers CompiledWasm module (a WebAssembly.Module): no fetch, no file.
import swephWasm from "./dist/sweph.wasm";
import { createEphemerisHandler } from "./handler.js";

const handle = createEphemerisHandler(swephWasm);

export default {
  fetch: (request) => handle(request),
};
