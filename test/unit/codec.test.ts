import { test } from "node:test";
import assert from "node:assert/strict";
import {
	apply, at, chunkPixels, decodeChange, decodeSnap, diff, encodeChange, encodeSnap, type Rec,
} from "../../shared/codec.js";
import { SIZE } from "../../shared/keys.js";

const area = () => new Uint16Array(SIZE * SIZE);
const block = (f: (i: number) => number) => Uint16Array.from({ length: 1024 }, (_, i) => f(i));

test("a chart's 2,048 bytes are 1,024 little-endian RGB565 pixels (§8.2)", () => {
	const raw = new Uint8Array(2048);
	raw[0] = 0x34;
	raw[1] = 0x12;
	raw[2046] = 0xcd;
	raw[2047] = 0xab;
	const px = chunkPixels(raw);
	assert.deepEqual([px.length, px[0], px[1023]], [1024, 0x1234, 0xabcd]);
});

test("a block's pixel sits at its area index, row-major: block 17's pixel 33 is area pixel (33, 33)", () => {
	assert.equal(at(17, 33), (33 * SIZE) + 33);
	assert.equal(at(255, 1023), (SIZE * SIZE) - 1);
	assert.equal(at(0, 0), 0);
});

test("the diff holds exactly the changed pixels, and nothing when none changed; applying twice is harmless", () => {
	const px = area();
	const next = block(() => 0);
	assert.equal(diff(px, 17, next, 5), undefined);
	next[3] = 7;
	next[700] = 9;
	const rec = diff(px, 17, next, 5)!;
	assert.deepEqual([rec.t, rec.block, [...rec.pos], [...rec.col]], [5, 17, [3, 700], [7, 9]]);
	apply(px, rec);
	assert.equal(px[at(17, 700)], 9);
	assert.equal(diff(px, 17, next, 6), undefined, "applied, the block matches");
	apply(px, rec);
	assert.equal(diff(px, 17, next, 6), undefined, "records hold colours, not deltas");
});

test("from 512 changed pixels on, the record holds the whole block, stored without positions (§8.3)", () => {
	const next = block(i => (i < 511 ? 1 : 0));
	const sparse = diff(area(), 0, next, 0)!;
	assert.equal(sparse.pos.length, 511, "511 changed: sparse");
	assert.equal(encodeChange(0, [sparse]).length, 4 + 7 + (4 * 511));
	next[511] = 1;
	const full = diff(area(), 0, next, 0)!;
	assert.equal(full.pos.length, 1024, "512 changed: whole");
	assert.deepEqual([...full.col], [...next]);
	assert.equal(encodeChange(0, [full]).length, 4 + 7 + 2048);
});

test("change files round-trip, each record at its own time", () => {
	const recs: Rec[] = [
		{ t: 1000, block: 3, pos: Uint16Array.from([1, 2]), col: Uint16Array.from([0xffff, 0]) },
		{ t: 1500, block: 255, pos: block(i => i), col: block(i => i * 3) },
		{ t: 4000, block: 0, pos: Uint16Array.from([1023]), col: Uint16Array.from([0x8001]) },
	];
	const bytes = encodeChange(1000, recs);
	assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), "MMC1");
	assert.deepEqual(decodeChange(1000, bytes), recs);
	assert.deepEqual(decodeChange(0, encodeChange(0, [])), [], "a file of no records");
});

test("a wrong magic or length is refused", () => {
	const bytes = encodeChange(0, [{ t: 0, block: 1, pos: Uint16Array.from([5]), col: Uint16Array.from([6]) }]);
	assert.throws(() => decodeChange(0, bytes.subarray(0, bytes.length - 1)), /truncated/);
	assert.throws(() => decodeChange(0, bytes.subarray(0, 9)), /truncated/);
	assert.throws(() => decodeChange(0, encodeSnap(area())), /MMC1/);
	assert.throws(() => decodeSnap(new Uint8Array(100)), /MMS1/);
	assert.throws(() => decodeSnap(encodeSnap(area()).subarray(1)), /MMS1/);
});

test("snapshots round-trip: MMS1, then 512 × 512 little-endian pixels (§8.4)", () => {
	const px = Uint16Array.from({ length: SIZE * SIZE }, (_, i) => (i * 7919) % 65536);
	const bytes = encodeSnap(px);
	assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), "MMS1");
	assert.equal(bytes.length, 4 + (2 * SIZE * SIZE));
	assert.equal(bytes[6], 7919 % 256, "pixel 1's low byte first");
	assert.deepEqual(decodeSnap(bytes), px);
});
