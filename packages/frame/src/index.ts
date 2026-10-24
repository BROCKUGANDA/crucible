/**
 * Gate 796's foundation: the frame reducer and the moment detector.
 *
 * Pure. It turns a trial's own event log into the ordered beats a replay is drawn from and a
 * commentary line is written against, and it hashes each frame so a stored line can later
 * prove which frame it spoke about. No chain reads, no clock, no model — those live above it.
 */

export * from "./events.js";
export * from "./moments.js";
export * from "./reducer.js";
