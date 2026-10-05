import { test } from "node:test";
import assert from "node:assert/strict";
import { at } from "../../shared/codec.js";
import { SIZE } from "../../shared/keys.js";
import { average, parentBlock, shrink } from "../../shared/levels.js";

const rgb = (r: number, g: number, b: number) => (r << 11) | (g << 5) | b;

test("a coarse pixel is the per-channel average of its four children, rounded half up (§8.6)", () => {
	assert.equal(average(0x1234, 0x1234, 0x1234, 0x1234), 0x1234);
	assert.equal(average(rgb(31, 63, 31), 0, 0, 0), rgb(8, 16, 8));
	assert.equal(average(rgb(1, 1, 1), rgb(1, 1, 1), 0, 0), rgb(1, 1, 1), "0.5 rounds up");
	assert.equal(average(rgb(1, 1, 1), 0, 0, 0), 0, "0.25 rounds down");
	assert.equal(average(rgb(31, 0, 0), rgb(0, 63, 0), rgb(0, 0, 31), rgb(31, 63, 31)), rgb(16, 32, 16),
		"channels never bleed into each other");
});

test("a child block shrinks into its quadrant of one parent block", () => {
	assert.equal(parentBlock(1, 1, 0), 136, "area (1, 1) is its parent's south-east quadrant: block 0 → (8, 8)");
	assert.equal(parentBlock(0, 0, 0), 0);
	assert.equal(parentBlock(0, 0, 1), 0, "blocks 0 and 1 share a parent block");
	assert.equal(parentBlock(0, 0, 2), 1);
	assert.equal(parentBlock(-1, -1, 255), 255, "area -1 is odd: its parent's south-east quadrant");
	const child = new Uint16Array(SIZE * SIZE);
	for (let p = 0; p < 1024; p++) {
		child[at(0, p)] = 0x1234;
	}
	const out = shrink(child, 136);
	for (let y = 0; y < 32; y++) {
		for (let x = 0; x < 32; x++) {
			assert.equal(out[(y * 32) + x], x < 16 && y < 16 ? 0x1234 : 0, `(${x}, ${y})`);
		}
	}
});
