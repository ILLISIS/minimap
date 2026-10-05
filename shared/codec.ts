// Change files (MMC1) and snapshots (MMS1), spec §8.2-8.4, and the block diff that makes change records. Bytes are
// little-endian through DataView; gzip is the callers' (node:zlib in the store, DecompressionStream in the viewer).
import { BLOCK, FULL, SIZE } from "./keys.js";

/** Block `block`'s pixels at `pos` (0..1023, row-major) took the colours `col` at time t (ms). */
export type Rec = { t: number; block: number; pos: Uint16Array; col: Uint16Array };

const C1 = [0x4d, 0x4d, 0x43, 0x31]; // "MMC1"
const S1 = [0x4d, 0x4d, 0x53, 0x31]; // "MMS1"
const SNAP = 4 + (2 * SIZE * SIZE);

/** The area pixel index of block `block`'s pixel `pos`. */
export function at(block: number, pos: number): number {
	return ((((block >> 4) * 32) + (pos >> 5)) * SIZE) + ((block & 15) * 32) + (pos & 31);
}

/** A chart from Lua (2,048 bytes, RGB565 little-endian, row-major) as 1,024 pixels (§8.2). */
export function chunkPixels(raw: Uint8Array): Uint16Array {
	const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	return Uint16Array.from({ length: BLOCK }, (_, i) => v.getUint16(2 * i, true));
}

/** The record that takes block `block` of the area pixels `px` to `next`, or undefined when nothing differs. */
export function diff(px: Uint16Array, block: number, next: Uint16Array, t: number): Rec | undefined {
	const pos: number[] = [];
	for (let p = 0; p < BLOCK; p++) {
		if (px[at(block, p)] !== next[p]) {
			pos.push(p);
		}
	}
	if (pos.length === 0) {
		return undefined;
	}
	if (pos.length >= FULL) {
		return { t, block, pos: Uint16Array.from({ length: BLOCK }, (_, i) => i), col: next.slice() };
	}
	return { t, block, pos: Uint16Array.from(pos), col: Uint16Array.from(pos, p => next[p]) };
}

/** Apply a record. Records hold colours, not deltas, so applying one twice changes nothing. */
export function apply(px: Uint16Array, rec: Rec): void {
	for (let i = 0; i < rec.pos.length; i++) {
		px[at(rec.block, rec.pos[i])] = rec.col[i];
	}
}

/** "MMC1", then per record: u32 dt (ms after t0), u8 block, u16 n (0: a whole block follows), the pixels (§8.3). */
export function encodeChange(t0: number, recs: Rec[]): Uint8Array {
	const whole = (r: Rec) => r.pos.length === BLOCK;
	const out = new Uint8Array(recs.reduce((n, r) => n + 7 + (whole(r) ? 2 * BLOCK : 4 * r.pos.length), 4));
	const v = new DataView(out.buffer);
	out.set(C1);
	let o = 4;
	for (const r of recs) {
		v.setUint32(o, r.t - t0, true);
		v.setUint8(o + 4, r.block);
		v.setUint16(o + 5, whole(r) ? 0 : r.pos.length, true);
		o += 7;
		for (let i = 0; i < r.pos.length; i++) {
			if (!whole(r)) {
				v.setUint16(o, r.pos[i], true);
				o += 2;
			}
			v.setUint16(o, r.col[i], true);
			o += 2;
		}
	}
	return out;
}

/** The records of a change file named t0. Throws on a wrong magic or a truncated record. */
export function decodeChange(t0: number, bytes: Uint8Array): Rec[] {
	if (bytes.length < 4 || !C1.every((b, i) => bytes[i] === b)) {
		throw new Error("not a change file (MMC1)");
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const recs: Rec[] = [];
	let o = 4;
	while (o < bytes.length) {
		const n = o + 7 <= bytes.length ? v.getUint16(o + 5, true) : -1;
		const count = n === 0 ? BLOCK : n;
		if (n < 0 || o + 7 + ((n === 0 ? 2 : 4) * count) > bytes.length) {
			throw new Error("change file truncated");
		}
		const t = t0 + v.getUint32(o, true);
		const block = v.getUint8(o + 4);
		o += 7;
		const pos = new Uint16Array(count);
		const col = new Uint16Array(count);
		for (let i = 0; i < count; i++) {
			if (n === 0) {
				pos[i] = i;
			} else {
				pos[i] = v.getUint16(o, true);
				o += 2;
			}
			col[i] = v.getUint16(o, true);
			o += 2;
		}
		recs.push({ t, block, pos, col });
	}
	return recs;
}

/** "MMS1", then the area's 512 × 512 pixels (§8.4). */
export function encodeSnap(px: Uint16Array): Uint8Array {
	const out = new Uint8Array(SNAP);
	const v = new DataView(out.buffer);
	out.set(S1);
	for (let i = 0; i < px.length; i++) {
		v.setUint16(4 + (2 * i), px[i], true);
	}
	return out;
}

export function decodeSnap(bytes: Uint8Array): Uint16Array {
	if (bytes.length !== SNAP || !S1.every((b, i) => bytes[i] === b)) {
		throw new Error(`not a snapshot (MMS1, ${SNAP} bytes)`);
	}
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Uint16Array.from({ length: SIZE * SIZE }, (_, i) => v.getUint16(4 + (2 * i), true));
}
