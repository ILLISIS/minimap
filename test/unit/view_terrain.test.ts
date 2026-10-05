import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, at, type Rec } from "../../shared/codec.js";
import { SIZE, chunkBlock } from "../../shared/keys.js";
import { Lru, MAX_SCALE, MIN_SCALE, level, paint, paintChunk, rgba, visible } from "../../web/view/terrain.js";

const pixel = (out: Uint8ClampedArray, i: number) => [...out.subarray(4 * i, (4 * i) + 4)];

test("RGB565 decodes to RGBA as §8.2 says, and uncharted (0) is opaque black", () => {
	const out = rgba(Uint16Array.from([0xf800, 0x07e0, 0x001f, 0x0000, 0xffff]));
	assert.deepEqual([0, 1, 2, 3, 4].map(i => pixel(out, i)), [
		[248, 0, 0, 255], [0, 252, 0, 255], [0, 0, 248, 255], [0, 0, 0, 255], [248, 252, 248, 255],
	]);
});

test("the level is clamp(floor(log2 s), 0, 4) over the scale's clamp [1/8, 32] (§11.2)", () => {
	const scales = [MIN_SCALE, 0.5, 1, 1.99, 2, 3.99, 4, 8, 16, 31, MAX_SCALE];
	assert.deepEqual(scales.map(level), [0, 0, 0, 0, 1, 1, 2, 3, 4, 4, 4]);
});

test("a 1920 × 1080 screen shows at most 9 × 6 = 54 areas at any scale and position (§11.2, REV M-8)", () => {
	for (let s = MIN_SCALE; s <= MAX_SCALE; s *= 1.07) {
		for (let x = -1000; x < 1000; x += 37) {
			for (let y = -1000; y < 1000; y += 41) {
				const n = visible({ x: x * s, y: y * s, s }, 1920, 1080).list.length;
				assert.ok(n <= 54, `${n} areas at s ${s}, ${x}, ${y}`);
			}
		}
	}
	// Just under s = 2, with both lower edges just below an area boundary: 9 columns and 6 rows.
	assert.equal(visible({ x: 1654.2, y: 818.5, s: 1.99 }, 1920, 1080).list.length, 54);
	// At one tile a pixel around the origin: x in [-960, 960) is areas -2..2, y in [-540, 540) is -1..1.
	const { z, list } = visible({ x: 0, y: 0, s: 1 }, 1920, 1080);
	assert.equal(z, 0);
	assert.deepEqual([list.length, list[0], list[14]], [15, [-2, -1], [2, 1]]);
});

test("the LRU evicts the least recently used past either cap, and reads with peek leave the order alone", () => {
	const lru = new Lru<number[]>(3, 10, v => v.length);
	lru.set("a", [1]);
	lru.set("b", [1]);
	lru.set("c", [1]);
	lru.get("a");
	lru.peek("b");
	lru.set("d", [1]);
	assert.deepEqual(lru.keys(), ["c", "a", "d"], "b was least recently used");
	lru.set("e", [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.deepEqual([lru.keys(), lru.bytes], [["a", "d", "e"], 10], "3 values at most");
	lru.set("f", [1, 2]);
	assert.deepEqual([lru.keys(), lru.bytes], [["e", "f"], 10], "10 bytes at most");
	lru.clear();
	assert.deepEqual([lru.size, lru.bytes], [0, 0]);
});

test("a record painted into RGBA equals the record applied to the pixels, then converted", () => {
	const px = new Uint16Array(SIZE * SIZE);
	const rec: Rec = {
		t: 1, block: 17, pos: Uint16Array.from([0, 33, 1023]), col: Uint16Array.from([0xf800, 1, 0xffff]),
	};
	const out = rgba(px);
	paint(out, rec);
	apply(px, rec);
	assert.deepEqual(out, rgba(px));
});

test("a live chunk lands in its block of the level-0 area; no bytes (deleted) paints it black", () => {
	const raw = new Uint8Array(2048).fill(0xff);
	const out = rgba(new Uint16Array(SIZE * SIZE));
	paintChunk(out, -9, 6, raw);
	const block = chunkBlock(-9, 6);
	const white = [248, 252, 248, 255];
	assert.deepEqual([pixel(out, at(block, 0)), pixel(out, at(block, 1023))], [white, white]);
	assert.deepEqual(pixel(out, at(block + 1, 0)), [0, 0, 0, 255], "the next block is untouched");
	paintChunk(out, -9, 6, undefined);
	assert.deepEqual(pixel(out, at(block, 512)), [0, 0, 0, 255]);
});
