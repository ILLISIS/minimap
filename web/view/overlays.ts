// Chart tags and recipes at time t (spec §8.9, §11.7), and the icon lookup over the mod pack export's metadata.
// DOM-free.
import type { Recipe, Tag } from "../../contracts.js";

/**
 * Tag and recipe versions, §8.9's tuple [instance, id, force, start, end | null, x, y, a, b]. A version is known by
 * everything but its end, since two states can open at one stamp (the store closes the first at that stamp).
 */
export class Versions<V extends Tag | Recipe> {
	private m = new Map<string, V>();

	clear(): void {
		this.m.clear();
	}

	/**
	 * A file's list or a live event's versions. A closed copy replaces an open one, never the other way: a file
	 * fetched before a live event closed a version still lists it open.
	 */
	add(list: V[], force: string): void {
		for (const v of list) {
			const key = JSON.stringify([v[0], v[1], v[3], v[5], v[6], v[7], v[8]]);
			if (v[2] === force && (v[4] !== null || !this.m.has(key))) {
				this.m.set(key, v);
			}
		}
	}

	/** The versions open at t: started at or before it, and not yet ended. */
	at(t: number): V[] {
		return [...this.m.values()].filter(v => v[3] <= t && (v[4] === null || v[4] > t));
	}
}

/** A sprite in the export's spritesheet (`clusterio/packages/lib/src/export.ts:117-127`). */
export type Icon = { x: number; y: number; size: number };
/** The export's metadata.json: entries per prototype base name (`clusterio/packages/host/src/export.ts:579-580`). */
export type IconMetadata = Record<string, { name: string; icon?: Icon }[]>;

/**
 * Sprites by the names tags and recipes use: a tag's `"<signal type>/<name>"` (Plan A's contract; the export calls
 * the `virtual` signal type `virtual-signal`) and `recipe/<name>`.
 */
export function iconIndex(meta: IconMetadata): Map<string, Icon> {
	const out = new Map<string, Icon>();
	for (const [base, entries] of Object.entries(meta)) {
		const type = base === "virtual-signal" ? "virtual" : base;
		for (const e of entries) {
			if (e.icon) {
				out.set(`${type}/${e.name}`, e.icon);
			}
		}
	}
	return out;
}
