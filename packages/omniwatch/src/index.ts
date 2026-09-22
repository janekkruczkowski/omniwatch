/**
 * Public entry point of the single OmniWatch library (D1/D4).
 *
 * One package, one version, one artifact: contracts, sources, analysis and the
 * durable store. The runtime is added here once T3 lands. Consumers use this
 * entry point or the explicit `@omniwatch/core/contracts` subpath; they never
 * import internal module paths.
 */

export * from "./contracts/index.ts";
export * from "./sources/index.ts";
export * from "./analysis/index.ts";
export * from "./storage/index.ts";
export * from "./runtime/index.ts";
