import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, gunzipSync } from "node:zlib";
import { at, decodeChange } from "../../shared/codec.js";
import {
	BLOCK, SIZE, areaKey, changeKey, chunkBlock, indexKey, snapKey, type Area, type AreaIndex,
} from "../../shared/keys.js";
import { parentBlock } from "../../shared/levels.js";
import { replay, select } from "../../shared/replay.js";
import { Disk, bytesWritten } from "../../store/disk.js";
import { Terrain, chunkResults } from "../../store/terrain.js";
import { tempDir } from "./fakes.js";

/** Lua's d: helpers.encode_string is zlib deflate, then base64 (§7.1). */
function chart(f: (p: number) => number): string {
	const raw = Buffer.alloc(2 * BLOCK);
	for (let p = 0; p < BLOCK; p++) {
		raw.writeUInt16LE(f(p), 2 * p);
	}
	return deflateSync(raw).toString("base64");
}
const flat = (colour: number) => chart(() => colour);

async function setup(lru?: number) {
	const disk = new Disk(await tempDir("terrain"));
	const warns: unknown[][] = [];
	const failures: string[] = [];
	const terrain = new Terrain(disk, (...args) => {
		warns.push(args);
	}, lru);
	const close = (c: number) => terrain.close(c, key => {
		failures.push(key);
	});
	return { disk, warns, failures, terrain, close };
}

const A0: Area = { map: "i-1", surface: "nauvis", force: "player", z: 0, ax: 0, ay: 0 };
const index = async (disk: Disk, a: Area) => (await disk.json<AreaIndex>(indexKey(a)))!;
const unzip = async (disk: Disk, key: string) => gunzipSync((await disk.get(key))!);

/** The area's pixels at t, read back from disk as the viewer reads them (§11.3). */
async function readAt(disk: Disk, a: Area, t: number): Promise<Uint16Array> {
	const { snap, changes } = select(await index(disk, a), t);
	const files = await Promise.all(changes.map(async c => ({ t: c, bytes: await unzip(disk, changeKey(a, c)) })));
	return replay(snap === undefined ? undefined : await unzip(disk, snapKey(a, snap)), files, t);
}

test("the disk: gzip files under their keys; keys() sorted, without temporaries or non-gzip files", async () => {
	const disk = new Disk(await tempDir("disk"));
	assert.deepEqual(await new Disk(join(disk.root, "missing")).keys(), []);
	const before = bytesWritten.get();
	const n = await disk.put("b/x.json.gz", JSON.stringify({ a: 1 }));
	const m = await disk.put("a/1.c.gz", new Uint8Array([1, 2, 3]));
	assert.equal(bytesWritten.get() - before, n + m);
	await writeFile(join(disk.root, "a", "1.c.0123456789abcdef.tmp.gz"), "");
	await writeFile(join(disk.root, "s3.json"), "{}");
	assert.deepEqual(await disk.keys(), ["a/1.c.gz", "b/x.json.gz"]);
	assert.deepEqual(await disk.json("b/x.json.gz"), { a: 1 });
	assert.equal(await disk.get("nope.gz"), undefined);
});

test("a change waits in the open window; the close writes its change file, first snapshot and index", async () => {
	const { disk, terrain, close } = await setup();
	const changed = chunkResults.labels("changed").get();
	const same = chunkResults.labels("same").get();
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 1000, flat(0x1234)), "changed");
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 2000, flat(0x1234)), "same");
	assert.deepEqual(
		[chunkResults.labels("changed").get() - changed, chunkResults.labels("same").get() - same], [1, 1],
	);
	assert.equal(terrain.open(areaKey(A0))?.t, 1000, "the open window, as the open route serves it (K25)");
	const { data, indexes } = await close(60_000);
	assert.deepEqual(data.slice(0, 2), [changeKey(A0, 1000), snapKey(A0, 60_000)], "level 0's files come first");
	assert.ok(indexes.includes(indexKey(A0)));
	assert.deepEqual(await index(disk, A0), { snaps: [60_000], changes: [[1000, 1000]] });
	const [rec] = decodeChange(1000, await unzip(disk, changeKey(A0, 1000)));
	assert.deepEqual([rec.t, rec.block, rec.pos.length, rec.col[0]], [1000, chunkBlock(0, 0), 1024, 0x1234]);
	assert.equal(terrain.open(areaKey(A0)), undefined, "nothing open after the close");
	assert.deepEqual(await close(120_000), { data: [], indexes: [] }, "an idle close writes nothing");
});

test("a deleted chunk is black again; a chart that isn't 2,048 bytes inflated is bad, counted and warned", async () => {
	const { disk, terrain, warns, close } = await setup();
	await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 1000, flat(0x1234));
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 2000), "changed", "no d: deleted");
	const bad = chunkResults.labels("bad").get();
	const short = deflateSync(Buffer.alloc(100)).toString("base64");
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 3000, short), "bad");
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 3000, "not deflate"), "bad");
	assert.equal(chunkResults.labels("bad").get() - bad, 2);
	assert.deepEqual(warns[0], ["bad_length 1", "minimap.chart bad_length", {
		op: "minimap.chart", phase: "bad_length", instance: 1, surface: "nauvis", x: 0, y: 0, length: 100,
	}]);
	await close(60_000);
	assert.ok((await readAt(disk, A0, 60_000)).every(v => v === 0), "uncharted is black (§8.2)");
});

test("snapshots (K11): after the first change file, after 64 files, and once the change bytes reach it", async () => {
	const { disk, terrain, close } = await setup();
	let seed = 1;
	// MINSTD: deterministic noise that gzip can't shrink, so a block of it is about 2 KB in any file.
	const noise = () => chart(() => {
		seed = (seed * 48271) % 2147483647;
		return seed % 65536;
	});
	for (let cx = 0; cx < 4; cx++) {
		await terrain.chunk(1, "i-1", "nauvis", "player", cx, 0, 1000, noise());
	}
	let c = 60_000;
	await close(c);
	assert.equal((await index(disk, A0)).snaps.length, 1, "the first file brings the first snapshot");
	for (let i = 1; i <= 64; i++) {
		c += 60_000;
		await terrain.chunk(1, "i-1", "nauvis", "player", 0, 1, c - 1000, chart(p => (p === 0 ? i : 0)));
		await close(c);
		assert.equal((await index(disk, A0)).snaps.length, i < 64 ? 1 : 2, `after ${i} one-pixel files`);
	}
	c += 60_000;
	for (let cx = 0; cx < 8; cx++) {
		await terrain.chunk(1, "i-1", "nauvis", "player", cx, 2, c - 1000, noise());
	}
	await close(c);
	assert.equal((await index(disk, A0)).snaps.length, 3, "a file as big as the snapshot brings the next");
});

test("a replay at any t equals applying every record up to t, across files and snapshots (§16.2)", async () => {
	const { disk, terrain, close } = await setup();
	const truth: { t: number; block: number; px: Uint16Array }[] = [];
	let c = 0;
	for (let w = 0; w < 70; w++) {
		c += 60_000;
		for (let k = 0; k < 3; k++) {
			const t = c - 50_000 + (k * 10_000);
			const cx = (w + k) % 5;
			const colour = (p: number) => (p < (w % 4) * 300 ? (w * 3) + k + 1 : (w * 3) + k + 2);
			await terrain.chunk(1, "i-1", "nauvis", "player", cx, 0, t, chart(colour));
			truth.push({ t, block: chunkBlock(cx, 0), px: Uint16Array.from({ length: BLOCK }, (_, p) => colour(p)) });
		}
		await close(c);
	}
	const expected = (until: number) => {
		const px = new Uint16Array(SIZE * SIZE);
		for (const r of truth.filter(x => x.t <= until)) {
			for (let p = 0; p < BLOCK; p++) {
				px[at(r.block, p)] = r.px[p];
			}
		}
		return px;
	};
	for (const until of [0, 15_000, 60_000, 61_000, 1_234_567, 2_000_000, 3_000_000, c]) {
		const want = expected(until);
		assert.ok((await readAt(disk, A0, until)).every((v, i) => v === want[i]), `t = ${until}`);
	}
	assert.ok((await index(disk, A0)).snaps.length >= 2, "the run crossed a snapshot");
});

test("a late stamp is filed after the area's last file, and the replay still matches (Review Focus 2)", async () => {
	const { disk, terrain, close } = await setup();
	await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 50_000, flat(1));
	await close(60_000);
	await terrain.chunk(2, "i-1", "nauvis", "player", 1, 0, 40_000, flat(2));
	await terrain.chunk(1, "i-1", "nauvis", "player", 2, 0, 39_000, flat(3));
	assert.equal(terrain.open(areaKey(A0))?.t, 60_001, "after the snapshot at 60,000");
	await close(120_000);
	assert.deepEqual((await index(disk, A0)).changes, [[50_000, 50_000], [60_001, 60_001]]);
	const pick = (px: Uint16Array) => [0, 1, 2].map(cx => px[at(chunkBlock(cx, 0), 0)]);
	assert.deepEqual(pick(await readAt(disk, A0, 60_001)), [1, 2, 3]);
	assert.deepEqual(pick(await readAt(disk, A0, 60_000)), [1, 0, 0], "not before the time it was filed at");
});

test("coarse levels (K20): exactly the changed parents, each a 2 × 2 average, stamped at the close", async () => {
	const { disk, terrain, close } = await setup();
	await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 1000, flat(0x1234));
	await close(60_000);
	let block = chunkBlock(0, 0);
	for (const [z, n] of [[1, 256], [2, 64], [3, 16], [4, 4]]) {
		block = parentBlock(0, 0, block);
		const a = { ...A0, z };
		assert.deepEqual(await index(disk, a), { snaps: [60_000], changes: [[60_000, 60_000]] }, `level ${z}`);
		const recs = decodeChange(60_000, await unzip(disk, changeKey(a, 60_000)));
		assert.equal(recs.length, 1, `one parent block at level ${z}`);
		assert.deepEqual([recs[0].t, recs[0].block, recs[0].pos.length], [60_000, block, n], `level ${z}`);
		assert.ok(recs[0].col.every(v => v === 0x1234), `level ${z}: the average of four equal pixels`);
	}
});

test("the LRU (K21) is trimmed at the close; an evicted area reloads its pixels and its next time", async () => {
	const { terrain, close } = await setup(4);
	for (let ax = 0; ax < 3; ax++) {
		await terrain.chunk(1, "i-1", "nauvis", "player", ax * 16, 0, 1000, flat(ax + 1));
	}
	await close(60_000);
	assert.equal(terrain.areas.size, 4, "8 areas over 5 levels, trimmed to 4");
	assert.equal(terrain.areas.has(areaKey(A0)), false, "the oldest went first");
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 61_000, flat(1)), "same", "reloaded");
	assert.equal(await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 62_000, flat(9)), "changed");
	assert.equal(terrain.open(areaKey(A0))?.t, 62_000);
});

test("a failed write keeps the area's records for the next close, under the same name (Review Focus 1)", async () => {
	const { disk, terrain, close, failures } = await setup();
	await terrain.chunk(1, "i-1", "nauvis", "player", 0, 0, 1000, flat(5));
	const put = disk.put.bind(disk);
	disk.put = async (key, data) => {
		if (key === changeKey(A0, 1000)) {
			throw new Error("disk full");
		}
		return put(key, data);
	};
	await close(60_000);
	assert.deepEqual(failures, [areaKey(A0)]);
	assert.equal(await disk.get(indexKey(A0)), undefined, "no index names a file that isn't there");
	await terrain.chunk(1, "i-1", "nauvis", "player", 1, 0, 70_000, flat(6));
	disk.put = put;
	await close(120_000);
	assert.deepEqual((await index(disk, A0)).changes, [[1000, 70_000]], "both records, in the file named by the first");
	assert.equal((await readAt(disk, A0, 120_000))[at(chunkBlock(1, 0), 0)], 6);
});
