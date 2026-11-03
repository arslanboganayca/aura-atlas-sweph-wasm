/*
 * Aura Atlas planet positions — the only part that touches Swiss Ephemeris (AGPL-3.0).
 * Exposes the two calls the chart needs, unchanged, to JavaScript through WebAssembly:
 *   swe_calc_ut    — position of one body (longitude, latitude, distance and their speeds)
 *   swe_solcross_ut — the moment the Sun reaches a given longitude (the design date)
 * The .se1 data files are embedded at /ephe. This file and the build are published under AGPL-3.0.
 */
#include <emscripten/emscripten.h>
#include "src/swephexp.h"

static int ready = 0;

static void init(void) {
  if (!ready) { swe_set_ephe_path("/ephe"); ready = 1; }
}

/* out: 6 doubles; err: 256 bytes. Returns the flag word Swiss Ephemeris returns (negative on error). */
EMSCRIPTEN_KEEPALIVE int aa_calc_ut(double jd_ut, int body, int flags, double *out, char *err) {
  init();
  return swe_calc_ut(jd_ut, body, flags, out, err);
}

/* Returns the Julian day (UT) of the next Sun crossing of x2cross after jd_ut; < jd_ut on error. */
EMSCRIPTEN_KEEPALIVE double aa_solcross_ut(double x2cross, double jd_ut, int flags, char *err) {
  init();
  return swe_solcross_ut(x2cross, jd_ut, flags, err);
}

EMSCRIPTEN_KEEPALIVE const char *aa_version(char *buf) {
  return swe_version(buf);
}
