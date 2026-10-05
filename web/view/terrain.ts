// Terrain in the browser (spec §8.2, §11.2, §11.3, K22): RGB565 to RGBA, the level for a scale, the areas a view
// shows, and the LRU both caches use. DOM-free, so it runs under node --test.
import { at, chunkPixels, type Rec } from "../../shared/codec.js";
import { BLOCK, LEVELS, SIZE, chunkBlock } from "../../shared/keys.js";

/** The scale's clamp, in tiles per screen pixel (§11.2). */
export const MIN_SCALE = 1 / 8;
export const MAX_SCALE = 32;

/** The map point at the screen's centre, in tiles, and the scale s in tiles per screen pixel. */
export type View = { x: number; y: number; s: number };

/** The level for scale s: clamp(floor(log2 s), 0, 4) (§11.2). */
export function level(s: number): number {
	return Math.min(LEVELS - 1, Math.max(0, Math.floor(Math.log2(s))));
}

/** The areas [ax, ay] a w × h screen shows, at the view's level (§11.2: at most 9 × 6 on 1920 × 1080). */
export function visible(v: View, w: number, h: number): { z: number; list: [number, number][] } {
	const z = level(v.s);
	const span = SIZE * 2 ** z;
	const from = (c: number, half: number) => Math.floor((c - half + 256) / span);
	const to = (c: number, half: number) => Math.ceil((c + half + 256) / span) - 1;
	const list: [number, number][] = [];
	for (let ay = from(v.y, h * v.s / 2); ay <= to(v.y, h * v.s / 2); ay++) {
		for (let ax = from(v.x, w * v.s / 2); ax <= to(v.x, w * v.s / 2); ax++) {
			list.push([ax, ay]);
		}
	}
	return { z, list };
}

/** RGB565 pixel v into RGBA `out` at pixel index i (§8.2's decode). */
function put(out: Uint8ClampedArray, i: number, v: number): void {
	out[4 * i] = ((v >> 11) & 31) << 3;
	out[(4 * i) + 1] = ((v >> 5) & 63) << 2;
	out[(4 * i) + 2] = (v & 31) << 3;
	out[(4 * i) + 3] = 255;
}

/** An area's pixels as RGBA, converted once (§11.3). */
export function rgba(px: Uint16Array): Uint8ClampedArray<ArrayBuffer> {
	const out = new Uint8ClampedArray(4 * px.length);
	for (let i = 0; i < px.length; i++) {
		put(out, i, px[i]);
	}
	return out;
}

/** A change record painted straight into an area's RGBA (§11.4's forward step). */
export function paint(out: Uint8ClampedArray, rec: Rec): void {
	for (let i = 0; i < rec.pos.length; i++) {
		put(out, at(rec.block, rec.pos[i]), rec.col[i]);
	}
}

/** A live chunk (§9.2) painted into its level-0 area's RGBA: 2,048 bytes, or none when deleted (uncharted, black). */
export function paintChunk(out: Uint8ClampedArray, cx: number, cy: number, raw: Uint8Array | undefined): void {
	const block = chunkBlock(cx, cy);
	const px = raw ? chunkPixels(raw) : new Uint16Array(BLOCK);
	for (let p = 0; p < BLOCK; p++) {
		put(out, at(block, p), px[p]);
	}
}

/** A least-recently-used map, capped by count and by total size (K22: 64 decoded areas; 32 MB of file bytes). */
export class Lru<V> {
	private m = new Map<string, V>();
	bytes = 0;

	constructor(public maxCount: number, private maxBytes = Infinity, private sizeOf: (v: V) => number = () => 0) {}

	get size(): number {
		return this.m.size;
	}

	/** The value, now the most recently used. */
	get(key: string): V | undefined {
		const v = this.m.get(key);
		if (v !== undefined) {
			this.m.delete(key);
			this.m.set(key, v);
		}
		return v;
	}

	/** The value, leaving the order alone (drawing reads with this). */
	peek(key: string): V | undefined {
		return this.m.get(key);
	}

	set(key: string, v: V): void {
		this.delete(key);
		this.m.set(key, v);
		this.bytes += this.sizeOf(v);
		for (const [old] of this.m) {
			if (this.m.size <= this.maxCount && this.bytes <= this.maxBytes) {
				break;
			}
			this.delete(old);
		}
	}

	delete(key: string): void {
		const v = this.m.get(key);
		if (v !== undefined) {
			this.bytes -= this.sizeOf(v);
			this.m.delete(key);
		}
	}

	clear(): void {
		this.m.clear();
		this.bytes = 0;
	}

	keys(): string[] {
		return [...this.m.keys()];
	}
}
