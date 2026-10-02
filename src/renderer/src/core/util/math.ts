// Scalar helpers shared by the rig math, the stores and the UI. Framework-free.

/** `v` limited to lo..hi; when the bounds cross (hi < lo, e.g. a popup larger than the viewport), lo wins. */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));
