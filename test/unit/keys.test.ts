import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CATALOG, area, areaKey, cacheControl, changeKey, chunkArea, chunkBlock, dayKey, name, pixel, tagsKey, unname,
	utcDay, validKey,
} from "../../shared/keys.js";

test("area and pixel at x = 255.5, 256, -256 and -256.5, at every level (C4: v1 threw a RangeError at 256)", () => {
	const cases: [number, number[], number[]][] = [
		[255.5, [0, 0, 0, 0, 0], [511, 255, 127, 63, 31]],
		[256, [1, 0, 0, 0, 0], [0, 256, 128, 64, 32]],
		[-256, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
		[-256.5, [-1, -1, -1, -1, -1], [511, 511, 511, 511, 511]],
	];
	for (const [x, areas, pixels] of cases) {
		assert.deepEqual([0, 1, 2, 3, 4].map(z => area(x, z)), areas, `areas of ${x}`);
		assert.deepEqual([0, 1, 2, 3, 4].map(z => pixel(x, z)), pixels, `pixels of ${x}`);
	}
	// The chunks holding those tiles: 7, 8, -8 and -9.
	assert.deepEqual([7, 8, -8, -9].map(chunkArea), [0, 1, 0, -1]);
	assert.deepEqual([7, 8, -8, -9].map(c => chunkBlock(c, c)), [255, 0, 0, 255]);
});

test("a chunk's area and block agree with its first tile's area and pixel", () => {
	for (let c = -40; c <= 40; c++) {
		assert.equal(chunkArea(c), area(32 * c, 0), `area of chunk ${c}`);
		assert.equal((chunkBlock(c, 0) % 16) * 32, pixel(32 * c, 0), `column of chunk ${c}`);
		assert.equal(Math.floor(chunkBlock(0, c) / 16) * 32, pixel(32 * c, 0), `row of chunk ${c}`);
	}
});

test("a T = 512 tile is exactly one level-0 area (K9)", () => {
	for (let t = -3; t <= 3; t++) {
		assert.deepEqual([area(512 * t - 256, 0), area(512 * t + 255.9, 0)], [t, t], `tile ${t}`);
		assert.deepEqual([pixel(512 * t - 256, 0), pixel(512 * t + 255.9, 0)], [0, 511], `tile ${t}`);
	}
});

test("names keep [A-Za-z0-9_-] and write every other UTF-8 byte as ~XX, and round-trip (K13)", () => {
	assert.equal(name("Bob's base"), "Bob~27s~20base");
	assert.equal(name("w1.x"), "w1~2Ex");
	assert.equal(name("日本"), "~E6~97~A5~E6~9C~AC");
	assert.equal(name("a~b!*()"), "a~7Eb~21~2A~28~29");
	for (const s of ["Bob's base", "nauvis", "日本", "..", "a/b", "a~b!*()", "player_1-x", "m"]) {
		assert.equal(unname(name(s)), s);
		assert.match(name(s), /^[A-Za-z0-9_~-]+$/, `${s} needs no URL encoding`);
	}
});

test("keys follow §8.1's tree, with names encoded and area coordinates signed", () => {
	const a = { map: "gw-w1", surface: "Bob's base", force: "player", z: 0, ax: -1, ay: 2 };
	assert.equal(areaKey(a), "gw-w1/Bob~27s~20base/player/0/-1_2");
	assert.equal(changeKey(a, 1759600000000), "gw-w1/Bob~27s~20base/player/0/-1_2/1759600000000.c.gz");
	assert.equal(tagsKey("i-7", "nauvis", "player"), "i-7/nauvis/player/tags.json.gz");
	assert.equal(dayKey("i-7", "nauvis", "2026-10-05"), "i-7/nauvis/m/2026-10-05.json.gz");
	assert.equal(utcDay(Date.UTC(2026, 9, 5, 23, 59, 59, 999)), "2026-10-05");
	assert.ok(validKey(changeKey(a, 1)));
});

test("the route refuses a `..` segment and characters outside the key set (§8.1)", () => {
	for (const bad of ["..", "a/../b", "a/..", "a b", "a//b", "/a", "a/", "a%2E%2E", "a\\b", "", "日本"]) {
		assert.equal(validKey(bad), false, JSON.stringify(bad));
	}
	assert.ok(validKey(CATALOG));
	assert.ok(validKey("i-7/~2E~2E/player/tags.json.gz"), "a surface named `..` is a plain encoded segment");
});

test("Cache-Control by kind (§10.4): immutable files and a finished day index, mutable files, live, the page", () => {
	const now = Date.UTC(2026, 9, 5, 12);
	const immutable = [
		"g/n/p/0/0_0/1.c.gz", "g/n/p/0/0_0/1.s.gz", "g/n/m/1.m.gz", "g/n/m/1.k.gz", "g/n/m/2026-10-04.json.gz",
		"viewer-0a1b2c3d.js", "icons/3f9a1c.png",
	];
	for (const key of immutable) {
		assert.equal(cacheControl(key, now), "max-age=31536000, immutable", key);
	}
	const mutable = [
		CATALOG, "g/n/p/0/0_0/index.json.gz", "g/n/m/2026-10-05.json.gz", "g/n/p/tags.json.gz",
		"g/n/p/0/0_0/recipes.json.gz",
	];
	for (const key of mutable) {
		assert.equal(cacheControl(key, now), "max-age=60", key);
	}
	assert.equal(cacheControl("g/n/live.json.gz", now), "max-age=5");
	assert.equal(cacheControl("index.html", now), "max-age=300");
});
