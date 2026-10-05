// Replay (spec §8.4, §11.3): which files make an area at time t, and its pixels then. The store reloads evicted
// areas with it (t = Infinity); the viewer plays history with it.
import { apply, decodeChange, decodeSnap } from "./codec.js";
import { SIZE, type AreaIndex } from "./keys.js";

/**
 * The files for time t: the latest snapshot at or before t, and the change files after it that start at or before
 * t. A snapshot named s holds exactly the records at or before s, and every later record is after s (plan ruling 2).
 */
export function select(index: AreaIndex, t: number): { snap?: number; changes: number[] } {
	const snap = index.snaps.filter(s => s <= t).pop();
	const changes = index.changes
		.filter(([first]) => first <= t && (snap === undefined || first > snap))
		.map(([first]) => first);
	return { snap, changes };
}

/** The pixels at t: the snapshot (gunzipped MMS1, or black), then the change files' records up to t, in order. */
export function replay(
	snap: Uint8Array | undefined,
	changes: { t: number; bytes: Uint8Array }[],
	t: number,
): Uint16Array {
	const px = snap ? decodeSnap(snap) : new Uint16Array(SIZE * SIZE);
	for (const file of changes) {
		for (const rec of decodeChange(file.t, file.bytes)) {
			// An area's record times never go back (plan ruling 2), so the first one past t ends the replay.
			if (rec.t > t) {
				return px;
			}
			apply(px, rec);
		}
	}
	return px;
}
