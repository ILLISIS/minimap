import { gunzipSync, inflateSync } from "node:zlib";
import * as lib from "@clusterio/lib";
import { apply, chunkPixels, diff, encodeChange, encodeSnap, type Rec } from "../shared/codec.js";
import {
	BLOCK, LEVELS, areaKey, changeKey, chunkArea, chunkBlock, indexKey, snapKey, type Area, type AreaIndex,
} from "../shared/keys.js";
import { parentBlock, shrink } from "../shared/levels.js";
import { replay, select } from "../shared/replay.js";
import type { Disk } from "./disk.js";

/** Charts from Lua by result (spec §14). */
export const chunkResults = new lib.Counter(
	"clusterio_minimap_chunks_total",
	"Minimap charts received, by result (changed, same, bad)",
	{ labels: ["result"] },
);

/** K21: the controller's area LRU holds 256 areas of 512 KB. */
export const LRU = 256;
/** K11: a snapshot after 64 change files, or once their bytes reach the last snapshot's. */
const SNAP_FILES = 64;

export type ChunkResult = "changed" | "same" | "bad";
export type Warn = (key: string, message: string, fields?: Record<string, unknown>) => void;

type State = {
	area: Area;
	key: string;
	px: Uint16Array;
	index: AreaIndex;
	/** This window's records, in time order. */
	open: Rec[];
	/** This window's changed blocks, for the coarse levels. */
	blocks: Set<number>;
	/** The earliest time the next record may take (plan ruling 2). */
	floor: number;
	/** K11: the last snapshot's file size, and the change files' bytes and count since it (plan ruling 3). */
	snapBytes: number;
	sinceBytes: number;
	sinceFiles: number;
	/** The index needs writing. */
	dirty: boolean;
};

export class Terrain {
	/** The LRU (K21): a Map iterates in insertion order, and get() re-inserts, so the first entry is the oldest. */
	readonly areas = new Map<string, State>();

	constructor(private disk: Disk, private warn: Warn, private lru = LRU) {}

	/**
	 * A chart from Lua (§6.2, §8.2): d is helpers.encode_string's output (deflate, base64), absent for a deleted
	 * chunk, which is black again. The chunk's block is diffed against the area's pixels; a change waits in the
	 * window for the close.
	 */
	async chunk(
		instance: number, map: string, surface: string, force: string, cx: number, cy: number, t: number, d?: string,
	): Promise<ChunkResult> {
		let next: Uint16Array = new Uint16Array(BLOCK);
		if (d !== undefined) {
			let raw: Uint8Array;
			try {
				raw = inflateSync(Buffer.from(d, "base64"));
			} catch {
				raw = new Uint8Array(0);
			}
			if (raw.length !== 2 * BLOCK) {
				chunkResults.labels("bad").inc();
				this.warn(`bad_length ${instance}`, "minimap.chart bad_length", {
					op: "minimap.chart", phase: "bad_length", instance, surface, x: cx, y: cy, length: raw.length,
				});
				return "bad";
			}
			next = chunkPixels(raw);
		}
		const s = await this.get({ map, surface, force, z: 0, ax: chunkArea(cx), ay: chunkArea(cy) });
		const rec = diff(s.px, chunkBlock(cx, cy), next, Math.max(t, s.floor));
		chunkResults.labels(rec ? "changed" : "same").inc();
		if (!rec) {
			return "same";
		}
		this.add(s, rec);
		return "changed";
	}

	/** Set a level-0 area's recipes flag (§8.5), written with its index at this close. */
	async markRecipes(area: Area): Promise<void> {
		const s = await this.get(area);
		if (!s.index.recipes) {
			s.index.recipes = true;
			s.dirty = true;
		}
	}

	/** The open window of the area at `key` (§9.1, K25): its records as a change file named t, or undefined. */
	open(key: string): { t: number; bytes: Uint8Array } | undefined {
		const s = this.areas.get(key);
		return s && s.open.length > 0 ? { t: s.open[0].t, bytes: encodeChange(s.open[0].t, s.open) } : undefined;
	}

	/**
	 * The close at c (§8.3-8.6): the coarse levels from this window's changed blocks, level by level; then per area
	 * its change file, a snapshot when K11 asks, and its index. Returns the keys written: data files, then indexes.
	 * A failed write is reported and the area keeps its records or its index for the next close (Review Focus 1).
	 */
	async close(c: number, failed: (key: string, err: Error) => void): Promise<{ data: string[]; indexes: string[] }> {
		for (let z = 1; z < LEVELS; z++) {
			for (const child of [...this.areas.values()].filter(s => s.area.z === z - 1 && s.blocks.size > 0)) {
				const { ax, ay } = child.area;
				const pa = { ...child.area, z, ax: Math.floor(ax / 2), ay: Math.floor(ay / 2) };
				let parent: State;
				try {
					parent = await this.get(pa);
				} catch (err: any) {
					// A parent that won't load (a corrupt index) is reported and skipped; the other areas still close.
					failed(areaKey(pa), err);
					continue;
				}
				for (const pb of new Set([...child.blocks].map(b => parentBlock(ax, ay, b)))) {
					const rec = diff(parent.px, pb, shrink(child.px, pb), Math.max(c, parent.floor));
					if (rec) {
						this.add(parent, rec);
					}
				}
			}
		}
		const data: string[] = [];
		const indexes: string[] = [];
		for (const s of this.areas.values()) {
			s.blocks.clear();
			if (s.open.length === 0 && !s.dirty) {
				continue;
			}
			try {
				if (s.open.length > 0) {
					await this.write(s, c, data);
				}
				await this.disk.put(indexKey(s.area), JSON.stringify(s.index));
				indexes.push(indexKey(s.area));
				s.dirty = false;
			} catch (err: any) {
				failed(s.key, err);
			}
		}
		// ponytail: trimmed only here, where nothing is open; a window that touches more than `lru` areas holds them
		// all until it closes (about 512 KB each).
		for (const [key, s] of this.areas) {
			if (this.areas.size <= this.lru) {
				break;
			}
			if (s.open.length === 0 && !s.dirty) {
				this.areas.delete(key);
			}
		}
		return { data, indexes };
	}

	/** The area's change file, named by its first record, then K11's snapshot, named after every record it holds. */
	private async write(s: State, c: number, data: string[]): Promise<void> {
		const first = s.open[0].t;
		const last = s.open[s.open.length - 1].t;
		s.sinceBytes += await this.disk.put(changeKey(s.area, first), encodeChange(first, s.open));
		data.push(changeKey(s.area, first));
		s.index.changes.push([first, last]);
		s.open = [];
		s.floor = last + 1;
		s.sinceFiles += 1;
		s.dirty = true;
		if (s.index.snaps.length === 0 || s.sinceFiles >= SNAP_FILES || s.sinceBytes >= s.snapBytes) {
			const at = Math.max(c, last);
			s.snapBytes = await this.disk.put(snapKey(s.area, at), encodeSnap(s.px));
			data.push(snapKey(s.area, at));
			s.index.snaps.push(at);
			s.floor = at + 1;
			s.sinceBytes = 0;
			s.sinceFiles = 0;
		}
	}

	private add(s: State, rec: Rec): void {
		apply(s.px, rec);
		s.open.push(rec);
		s.blocks.add(rec.block);
		s.floor = rec.t;
	}

	private async get(area: Area): Promise<State> {
		const key = areaKey(area);
		let s = this.areas.get(key);
		if (s) {
			this.areas.delete(key);
		} else {
			s = await this.load(area, key);
		}
		this.areas.set(key, s);
		return s;
	}

	/** An area from disk (§8.4): its latest snapshot and the change files since, so a reload reads at most 64. */
	private async load(area: Area, key: string): Promise<State> {
		const index = await this.disk.json<AreaIndex>(indexKey(area)) ?? { snaps: [], changes: [] };
		const { snap, changes } = select(index, Infinity);
		const snapGz = snap === undefined ? undefined : await this.disk.get(snapKey(area, snap));
		const files = await Promise.all(changes.map(async t => ({
			t, gz: (await this.disk.get(changeKey(area, t)))!,
		})));
		const bytes = files.map(f => ({ t: f.t, bytes: gunzipSync(f.gz) }));
		const px = replay(snapGz && gunzipSync(snapGz), bytes, Infinity);
		const last = Math.max(snap ?? -1, index.changes.at(-1)?.[1] ?? -1);
		return {
			area, key, px, index, open: [], blocks: new Set(), floor: last + 1, dirty: false,
			snapBytes: snapGz?.length ?? 0,
			sinceBytes: files.reduce((n, f) => n + f.gz.length, 0),
			sinceFiles: files.length,
		};
	}
}
