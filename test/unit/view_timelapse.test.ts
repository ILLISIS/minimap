import { test } from "node:test";
import assert from "node:assert/strict";
import { at, encodeChange, encodeSnap, type Rec } from "../../shared/codec.js";
import {
	CATALOG, SIZE, areaKey, changeKey, dayKey, indexKey, keyframeKey, moveKey, snapKey, utcDay, type Area,
} from "../../shared/keys.js";
import { catalog, setup } from "./view_fakes.js";

const DAY = 86_400_000;
const A0: Area = { map: "i-1", surface: "nauvis", force: "player", z: 0, ax: 0, ay: 0 };
const rec = (t: number, block: number, col: number): Rec => ({
	t, block, pos: Uint16Array.from([0]), col: Uint16Array.from([col]),
});
const snap = (pixels: [number, number][]) => {
	const px = new Uint16Array(SIZE * SIZE);
	for (const [block, col] of pixels) {
		px[at(block, 0)] = col;
	}
	return encodeSnap(px);
};

/** Snapshots at 100 and 200; change files at 150 (records 150 and 160) and 250. */
function files(): Map<string, unknown> {
	return new Map<string, unknown>([
		[CATALOG, catalog([["0_0"], [], [], [], []], { first: 100 })],
		[indexKey(A0), { snaps: [100, 200], changes: [[150, 160], [250, 250]] }],
		[snapKey(A0, 100), snap([[0, 0x001f]])],
		[snapKey(A0, 200), snap([[0, 0x07e0], [1, 0xffff]])],
		[changeKey(A0, 150), encodeChange(150, [rec(150, 0, 0x07e0), rec(160, 1, 0xffff)])],
		[changeKey(A0, 250), encodeChange(250, [rec(250, 0, 0xf800)])],
	]);
}

test("forward applies the records held; back, or past a snapshot, reloads from the snapshot (§11.4)", async () => {
	const { viewer, settle, requests } = setup(files());
	const pixel = (block: number) => {
		const i = 4 * at(block, 0);
		return [...viewer.areas.peek(areaKey(A0))!.rgba.subarray(i, i + 3)];
	};
	viewer.seek(155);
	await viewer.refresh();
	await settle();
	const first = viewer.areas.peek(areaKey(A0));
	assert.deepEqual([pixel(0), pixel(1)], [[0, 252, 0], [0, 0, 0]]);
	let before = requests.length;
	viewer.seek(180);
	await settle();
	assert.equal(viewer.areas.peek(areaKey(A0)), first, "forward: the same area, stepped");
	assert.deepEqual([pixel(1), requests.slice(before)], [[248, 252, 248], []], "record 160 from the file held");
	before = requests.length;
	viewer.seek(255);
	await settle();
	assert.notEqual(viewer.areas.peek(areaKey(A0)), first, "past the snapshot at 200: reloaded from it");
	assert.deepEqual([pixel(0), requests.slice(before)], [[248, 0, 0], [snapKey(A0, 200), changeKey(A0, 250)]]);
	const third = viewer.areas.peek(areaKey(A0));
	viewer.seek(120);
	await settle();
	assert.notEqual(viewer.areas.peek(areaKey(A0)), third, "back: reloaded");
	assert.deepEqual([pixel(0), pixel(1)], [[0, 0, 248], [0, 0, 0]]);
});

test("playing moves the time shown at speed × browser time, and catching up with now goes live (§11.4)", async () => {
	const { viewer, settle, perf, run } = setup(files());
	await viewer.refresh();
	await settle();
	viewer.seek(100);
	viewer.play(60);
	perf.now += 1000;
	run();
	assert.equal(viewer.at, 100 + 60_000, "a minute a second");
	viewer.play(86_400);
	perf.now += 1000;
	run();
	assert.deepEqual([viewer.at, viewer.speed], [undefined, 0], "past now (1,000,000 + 2 s): live");
	assert.deepEqual(viewer.range(), [100, 1_002_000]);
	await settle();
});

test("the view has ended once the catalog's updated is over 2W + 60 s old by the data clock (§11.8)", async () => {
	const { viewer, settle, perf } = setup(files());
	await viewer.refresh();
	await settle();
	perf.now = (2 * 60_000) + 60_000;
	assert.equal(viewer.ended(), undefined, "2W + 60 s exactly: not yet");
	perf.now += 1;
	assert.deepEqual([viewer.ended(), viewer.range()[1]], [1_000_000, 1_000_000]);
	const fresh = setup(files());
	await fresh.viewer.refresh();
	fresh.viewer.clock.see(1_000_000 + 180_001);
	assert.equal(fresh.viewer.ended(), 1_000_000, "a later visitor: the server's Date says so at once");
	await fresh.settle();
});

test("playing never re-asks for a missing movement window until the next refresh", async () => {
	const T = Date.UTC(2026, 9, 5, 12);
	const cat = catalog([[], [], [], [], []], { first: T, days: [utcDay(T)] });
	cat.updated = T + 600_000;
	const window = moveKey("i-1", "nauvis", T + 1000);
	const { viewer, perf, run, requests } = setup(new Map<string, unknown>([
		[CATALOG, cat],
		[dayKey("i-1", "nauvis", utcDay(T)), { windows: [[T + 1000, T + 3000]], keys: [] }],
	]));
	await viewer.refresh();
	viewer.seek(T + 2000);
	viewer.play(60);
	for (let i = 0; i < 20; i++) {
		perf.now += 100;
		run();
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	assert.equal(requests.filter(k => k === window).length, 1);
	viewer.close();
});

test("refresh restarts the live source when the surface's live flag changed", async () => {
	const map = files();
	const { viewer, settle, lives } = setup(map);
	await viewer.refresh();
	await settle();
	assert.equal(lives.length, 1);
	await viewer.refresh();
	assert.equal(lives.length, 1, "same flag: kept");
	map.set(CATALOG, catalog([["0_0"], [], [], [], []], { first: 100, live: false }));
	await viewer.refresh();
	await settle();
	assert.deepEqual(lives.map(l => l.stopped), [true, false], "the flag went away: restarted");
});

test("Live during play stops the playing: no frame follows", async () => {
	const { viewer, settle, run } = setup(files());
	await viewer.refresh();
	await settle();
	viewer.seek(100);
	viewer.play(60);
	viewer.seek(undefined);
	run();
	assert.deepEqual([viewer.speed, run()], [0, 0]);
});

test("playing across two keyframes keeps only the second span's movers and windows (memory bounded)", async () => {
	const T = Date.UTC(2026, 9, 5, 12);
	const K2 = T + 600_000;
	const cat = catalog([[], [], [], [], []], { first: T, days: [utcDay(T)] });
	cat.updated = T + DAY;
	const key = (t: number, id: string) => [keyframeKey("i-1", "nauvis", t), {
		t, movers: [[id, "v", "player", "car", 0, 4, 0, 0, 0, t]],
	}] as [string, unknown];
	const win = (t: number, id: string) => [moveKey("i-1", "nauvis", t), {
		t, movers: [[id, "p", "player", id]], s: [[0, 0, 0, 0, 0, 0]],
	}] as [string, unknown];
	const { viewer, settle } = setup(new Map<string, unknown>([
		[CATALOG, cat],
		[dayKey("i-1", "nauvis", utcDay(T)), {
			windows: [[T + 1000, T + 3000], [K2 + 1000, K2 + 3000]], keys: [T, K2],
		}],
		key(T, "k1"), key(K2, "k2"), win(T + 1000, "w1"), win(K2 + 1000, "w2"),
	]));
	await viewer.refresh();
	viewer.seek(T + 2000);
	await settle();
	assert.equal(viewer.past.size, 2, "k1 and w1");
	viewer.seek(K2 + 2000);
	await settle();
	assert.deepEqual(viewer.movers.map(m => m.id).sort(), ["k2", "w2"]);
	assert.equal(viewer.past.size, 2, "the first span's movers are dropped");
});

test("no movement windows are requested above an hour a second (plan ruling 19)", async () => {
	const T = Date.UTC(2026, 9, 5, 12);
	const cat = catalog([[], [], [], [], []], { first: T, days: [utcDay(T)] });
	cat.updated = T + (3 * DAY);
	const { viewer, perf, run, requests } = setup(new Map<string, unknown>([
		[CATALOG, cat],
		[dayKey("i-1", "nauvis", utcDay(T)), { windows: [[T + 1000, T + 3000]], keys: [] }],
	]));
	await viewer.refresh();
	viewer.seek(T + 2000);
	viewer.play(86_400);
	for (let i = 0; i < 10; i++) {
		perf.now += 100;
		run();
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	assert.deepEqual(requests.filter(k => k.includes("/m/")), []);
	viewer.close();
});
