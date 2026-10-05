import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import type { LiveMover } from "../../contracts.js";
import { at, encodeChange, encodeSnap, type Rec } from "../../shared/codec.js";
import {
	CATALOG, SIZE, areaKey, changeKey, chunkBlock, dayKey, indexKey, keyframeKey, moveKey, snapKey, type Area,
} from "../../shared/keys.js";
import { choose } from "../../web/view/viewer.js";
import { catalog, setup, type Open } from "./view_fakes.js";

const A0: Area = { map: "i-1", surface: "nauvis", force: "player", z: 0, ax: 0, ay: 0 };
const rec = (t: number, block: number, col: number): Rec => ({
	t, block, pos: Uint16Array.from([0]), col: Uint16Array.from([col]),
});
/** Area pixel (block, 0)'s RGBA in the viewer's entry for `a`. */
function colour(v: { areas: { peek(key: string): { rgba: Uint8ClampedArray } | undefined } }, a: Area, block: number) {
	const i = 4 * at(block, 0);
	return [...v.areas.peek(areaKey(a))!.rgba.subarray(i, i + 3)];
}
const RED = [248, 0, 0];
const GREEN = [0, 252, 0];
const BLUE = [0, 0, 248];
const BLACK = [0, 0, 0];
const WHITE = [248, 252, 248];

/** One area with a snapshot at 100 and change files at 50, 150 (records 150 and 160) and 250. */
function history(): Map<string, unknown> {
	const snap = new Uint16Array(SIZE * SIZE);
	snap[at(0, 0)] = 0x001f;
	return new Map<string, unknown>([
		[CATALOG, catalog([["0_0"], [], [], [], []])],
		[indexKey(A0), { snaps: [100], changes: [[50, 50], [150, 160], [250, 250]] }],
		[snapKey(A0, 100), encodeSnap(snap)],
		[changeKey(A0, 50), encodeChange(50, [rec(50, 0, 0xf800)])],
		[changeKey(A0, 150), encodeChange(150, [rec(150, 0, 0x07e0), rec(160, 1, 0xffff)])],
		[changeKey(A0, 250), encodeChange(250, [rec(250, 0, 0xf800)])],
	]);
}

test("an area at t is the snapshot at or before t and the change files after it, up to t (§11.3)", async () => {
	const { viewer, settle, requests } = setup(history());
	viewer.seek(155);
	await viewer.refresh();
	await settle();
	assert.deepEqual([colour(viewer, A0, 0), colour(viewer, A0, 1)], [GREEN, BLACK], "record 160 is after t");
	assert.deepEqual(requests.filter(k => k.endsWith(".gz") && k !== CATALOG), [
		indexKey(A0), snapKey(A0, 100), changeKey(A0, 150),
	]);
});

test("live, an area is every file plus the open window, fetched before the index (§11.3, B's ruling 9)", async () => {
	const open: Open = new Map([[areaKey(A0), { t: 300, bytes: encodeChange(300, [rec(300, 2, 0x001f)]) }]]);
	const { viewer, settle, requests } = setup(history(), open);
	await viewer.refresh();
	await settle();
	assert.deepEqual([colour(viewer, A0, 0), colour(viewer, A0, 1), colour(viewer, A0, 2)], [RED, WHITE, BLUE]);
	assert.equal(viewer.areas.peek(areaKey(A0))!.t, 300, "the newest record applied");
	assert.ok(requests.indexOf(`open:${areaKey(A0)}`) < requests.indexOf(indexKey(A0)));
});

test("a frame is drawn only on a change: the view, data, the time, or a mover on screen (§11.8)", async () => {
	const files = new Map([[CATALOG, catalog([[], [], [], [], []])]]);
	const { viewer, settle, queue, run, perf, lives, draws } = setup(files);
	await viewer.refresh();
	await settle();
	const drawn = draws();
	perf.now += 600_000;
	assert.equal(queue.length, 0, "ten idle minutes ask for no frame");
	viewer.move({ x: 5, y: 0, s: 1 });
	viewer.move({ x: 6, y: 0, s: 1 });
	assert.equal(run(), 1, "two moves before a frame: one frame");
	assert.equal(draws(), drawn + 1);
	const T = 2_000_000_000;
	const bob: LiveMover = ["p:bob", "p", "player", "bob", 0, 0, 0, 5, 0, T];
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: [bob] });
	await settle().catch(() => {}); // it never settles while bob walks
	assert.equal(queue.length, 1, "bob walks on screen: frames keep coming");
	perf.now += 61_000;
	run();
	const held = draws();
	perf.now += 5000;
	run();
	assert.equal(draws(), held, "60 s of data time after his last sample he holds, and frames stop (K31)");
	const far: LiveMover = ["p:amy", "p", "player", "amy", 0, 99_999, 0, 5, 0, T + 61_000];
	lives[0].on({ t: T + 61_000, map: "i-1", surface: "nauvis", movers: [far] });
	await settle();
	const idle = draws();
	perf.now += 5000;
	run();
	assert.equal(draws(), idle, "a mover off screen asks for no frame");
});

test("only areas the catalog lists are fetched, at most 54 at any zoom on 1920 × 1080 (§11.2)", async () => {
	const all: string[] = [];
	for (let ay = -20; ay <= 20; ay++) {
		for (let ax = -20; ax <= 20; ax++) {
			all.push(`${ax}_${ay}`);
		}
	}
	const { viewer, settle, requests } = setup(new Map([[CATALOG, catalog([all, all, all, all, all])]]));
	await viewer.refresh();
	for (let s = 1 / 8; s <= 32; s *= 1.5) {
		viewer.move({ x: 1654.2 * s / 1.99, y: 818.5 * s / 1.99, s });
		const before = requests.length;
		await settle();
		const asked = new Set(requests.slice(before).filter(k => k.endsWith("/index.json.gz")));
		assert.ok(viewer.shown.length <= 54 && asked.size <= 54, `s ${s}: ${viewer.shown.length}, ${asked.size}`);
	}
	const one = setup(new Map([[CATALOG, catalog([["0_0"], [], [], [], []])]]));
	await one.viewer.refresh();
	await one.settle();
	const indexes = one.requests.filter(k => k.endsWith("/index.json.gz"));
	assert.deepEqual(indexes, [indexKey(A0)], "14 more on screen, unlisted");
});

test("the caches hold 64 decoded areas and 32 MB of file bytes (K22)", async () => {
	const snap = encodeSnap(new Uint16Array(SIZE * SIZE));
	const listed: string[] = [];
	const files = new Map<string, unknown>();
	for (let ax = 0; ax < 100; ax++) {
		const a = { ...A0, ax };
		listed.push(`${ax}_0`);
		files.set(indexKey(a), { snaps: [1], changes: [] });
		files.set(snapKey(a, 1), snap);
	}
	files.set(CATALOG, catalog([listed, [], [], [], []]));
	const { viewer, settle, requests } = setup(files);
	await viewer.refresh();
	for (let ax = 0; ax < 100; ax++) {
		viewer.move({ x: 512 * ax, y: 0, s: 1 / 8 });
		await settle();
	}
	assert.equal(requests.filter(k => k.endsWith(".s.gz")).length, 100);
	assert.equal(viewer.areas.size, 64);
	assert.ok(viewer.bytes.bytes <= 32 * 1024 * 1024 && viewer.bytes.size === 63, `${viewer.bytes.size} snapshots`);
});

test("a switch leaves nothing of the old selection behind, even results still in flight (C7)", async () => {
	const files = history();
	const cat = files.get(CATALOG) as ReturnType<typeof catalog>;
	cat.maps["i-1"].surfaces.vulcanus = structuredClone(cat.maps["i-1"].surfaces.nauvis);
	const V0 = { ...A0, surface: "vulcanus" };
	files.set(indexKey(V0), { snaps: [], changes: [] });
	let release = () => {};
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const gate = (key: string) => (key.startsWith("i-1/nauvis/") ? held : Promise.resolve());
	const { viewer, settle, run, lives } = setup(files, undefined, gate);
	await viewer.refresh();
	run();
	assert.equal(viewer.loading, 1, "nauvis's area is loading");
	viewer.select({ map: "i-1", surface: "vulcanus", force: "player" });
	release();
	await settle();
	const T = 2_000_000_000;
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: [["p:bob", "p", "player", "bob", 0, 0, 0, 0, 0, T]] });
	await settle();
	assert.deepEqual(viewer.areas.keys(), [areaKey(V0)]);
	assert.deepEqual(viewer.bytes.keys(), []);
	assert.equal(viewer.present.size, 0, "a late live update for nauvis is dropped");
	assert.deepEqual(lives.map(l => [l.surface, l.stopped]), [["nauvis", true], ["vulcanus", false]]);
});

test("a live chunk repaints its level-0 block, also while its area loads; a deleted one is black (§11.3)", async () => {
	let release = () => {};
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const gate = (key: string) => (key === indexKey(A0) ? held : Promise.resolve());
	const { viewer, settle, run, lives } = setup(history(), undefined, gate);
	await viewer.refresh();
	run();
	const chunk = (force: string, d: string) => lives[0].on({
		t: 1_000_500, map: "i-1", surface: "nauvis", chunks: [[force, 0, 0, d]],
	});
	const white = deflateSync(new Uint8Array(2048).fill(0xff)).toString("base64");
	chunk("player", white);
	// The chunk's inflate runs on the threadpool: wait until it is applied (held), and only the gated load is left.
	for (let i = 0; i < 500 && viewer.loading !== 1; i++) {
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	assert.equal(viewer.loading, 1);
	release();
	await settle();
	const block = chunkBlock(0, 0);
	assert.deepEqual(colour(viewer, A0, block), WHITE, "arrived while loading, painted when it landed");
	chunk("player", "");
	chunk("enemy", white);
	chunk("player", "not zlib");
	await settle();
	assert.deepEqual(colour(viewer, A0, block), BLACK, "deleted; the enemy's and the broken chunk are skipped");
});

test("live, the refresh reloads an area with its new files; the files held come from the cache (§11.3)", async () => {
	const files = history();
	const { viewer, settle, requests } = setup(files);
	await viewer.refresh();
	await settle();
	assert.deepEqual(colour(viewer, A0, 3), BLACK);
	files.set(indexKey(A0), { snaps: [100], changes: [[50, 50], [150, 160], [250, 250], [400, 400]] });
	files.set(changeKey(A0, 400), encodeChange(400, [rec(400, 3, 0x07e0)]));
	const before = requests.length;
	await viewer.refresh();
	await settle();
	assert.deepEqual(colour(viewer, A0, 3), GREEN);
	assert.deepEqual(requests.slice(before), [CATALOG, indexKey(A0), changeKey(A0, 400)]);
});

test("more than 64 areas on screen (2560 × 1440 at s 1.99) are all kept: an idle redraw fetches nothing", async () => {
	const all: string[] = [];
	for (let ax = -5; ax <= 15; ax++) {
		for (let ay = -5; ay <= 15; ay++) {
			all.push(`${ax}_${ay}`);
		}
	}
	const { viewer, settle, requests, run } = setup(new Map([[CATALOG, catalog([all, [], [], [], []])]]));
	viewer.resize(2560, 1440);
	// Both lower edges just below an area boundary: areas -1..9 by -1..5.
	viewer.move({ x: 2291.1, y: 1176.7, s: 1.99 });
	await viewer.refresh();
	await settle();
	assert.equal(viewer.shown.length, 77, "11 × 7");
	assert.equal(viewer.areas.size, 77);
	const before = requests.length;
	viewer.invalidate();
	run();
	await settle();
	assert.equal(requests.length, before);
});

test("history's movers: the keyframe before t and the windows since, from t's day and the day before", async () => {
	const T = Date.UTC(2026, 9, 5, 12);
	const files = new Map<string, unknown>([
		[CATALOG, catalog([[], [], [], [], []], { days: ["2026-10-05"] })],
		[dayKey("i-1", "nauvis", "2026-10-05"), { windows: [[T - 5000, T - 4000], [T + 1000, T + 3000]], keys: [T] }],
		[keyframeKey("i-1", "nauvis", T), { t: T, movers: [["1.5.v7", "v", "player", "car", 0, 4, 0, 0, 0, T - 9e3]] }],
		[moveKey("i-1", "nauvis", T + 1000), {
			t: T + 1000, movers: [["p:bob", "p", "player", "bob"]], s: [[0, 0, 0, 0, 1, 0], [0, 2000, 2, 0, 1, 0]],
		}],
	]);
	const { viewer, settle, requests } = setup(files);
	viewer.seek(T + 2000);
	await viewer.refresh();
	await settle();
	assert.deepEqual(viewer.movers.map(m => [m.id, m.x]).sort(), [["1.5.v7", 4], ["p:bob", 1]]);
	assert.deepEqual(requests.filter(k => k.includes("/m/")).sort(), [
		dayKey("i-1", "nauvis", "2026-10-05"), moveKey("i-1", "nauvis", T + 1000), keyframeKey("i-1", "nauvis", T),
	].sort(), "the window before the keyframe isn't fetched; 2026-10-04 isn't listed");
});

test("choose keeps what the catalog has, and falls back to its first map, surface and force", () => {
	const cat = catalog([[], [], [], [], []]);
	const nauvis = cat.maps["i-1"].surfaces.nauvis;
	cat.maps["i-1"].surfaces.vulcanus = { ...nauvis, forces: { enemy: nauvis.forces.player } };
	cat.maps["i-1"].instances = { 7: { name: "seven", bounds: [0, 0, 512, 512] } };
	const first = { map: "i-1", surface: "nauvis", force: "player", instance: undefined };
	assert.deepEqual(choose(cat), first);
	assert.deepEqual(choose(cat, { map: "gone", surface: "nope" }), first);
	assert.deepEqual(choose(cat, { ...first, surface: "vulcanus", instance: "7" }), {
		...first, surface: "vulcanus", force: "enemy", instance: "7",
	});
	assert.equal(choose({ ...cat, maps: {} }), undefined);
});

test("a load that lands, and a seek, each ask for a frame (§11.8)", async () => {
	const { viewer, run, draws } = setup(history());
	await viewer.refresh();
	run();
	const waitLoaded = async () => {
		for (let i = 0; i < 500 && viewer.loading !== 0; i++) {
			await new Promise(resolve => setTimeout(resolve, 2));
		}
	};
	const first = draws();
	await waitLoaded();
	assert.equal(run(), 1, "the landed area asks for a frame");
	assert.equal(draws(), first + 1);
	viewer.seek(155);
	assert.equal(run(), 1, "a seek asks for a frame");
	assert.equal(draws(), first + 2);
});

test("a failed load is not asked for again every frame; a refresh, a switch or a seek lets it retry", async () => {
	const files = history();
	files.set(changeKey(A0, 150), new Uint8Array([1, 2, 3]));
	const { viewer, run, perf, lives, requests } = setup(files);
	await viewer.refresh();
	const T = 2_000_000_000;
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: [["p:bob", "p", "player", "bob", 0, 0, 0, 1, 0, T]] });
	const frames = async (n: number) => {
		for (let i = 0; i < n; i++) {
			await new Promise(resolve => setTimeout(resolve, 1));
			perf.now += 16;
			run();
		}
	};
	// The index is fetched on each attempt; the bad file itself comes from the bytes cache the second time.
	const bad = () => requests.filter(k => k === indexKey(A0)).length;
	await frames(300);
	assert.equal(bad(), 1, "300 frames, one request");
	await viewer.refresh();
	await frames(50);
	assert.equal(bad(), 2, "the refresh retried once");
});

test("a live update that arrives after a switch to another force of the same surface is dropped (C7)", async () => {
	const cat = catalog([[], [], [], [], []]);
	const surface = cat.maps["i-1"].surfaces.nauvis;
	surface.forces.enemy = surface.forces.player;
	const { viewer, settle, lives } = setup(new Map([[CATALOG, cat]]));
	await viewer.refresh();
	await settle();
	viewer.select({ map: "i-1", surface: "nauvis", force: "enemy" });
	const T = 2_000_000_000;
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: [["p:bob", "p", "player", "bob", 0, 0, 0, 0, 0, T]] });
	await settle();
	assert.equal(viewer.present.size, 0);
});

test("a refresh during paused history keeps the movers and fetches no window or keyframe", async () => {
	const T = Date.UTC(2026, 9, 5, 12);
	const files = new Map<string, unknown>([
		[CATALOG, catalog([[], [], [], [], []], { days: ["2026-10-05"] })],
		[dayKey("i-1", "nauvis", "2026-10-05"), { windows: [[T + 1000, T + 3000]], keys: [T] }],
		[keyframeKey("i-1", "nauvis", T), { t: T, movers: [["1.5.v7", "v", "player", "car", 0, 4, 0, 0, 0, T - 9e3]] }],
		[moveKey("i-1", "nauvis", T + 1000), {
			t: T + 1000, movers: [["p:bob", "p", "player", "bob"]], s: [[0, 0, 0, 0, 1, 0], [0, 2000, 2, 0, 1, 0]],
		}],
	]);
	const { viewer, settle, requests, run } = setup(files);
	viewer.seek(T + 2000);
	await viewer.refresh();
	await settle();
	assert.equal(viewer.movers.length, 2);
	requests.length = 0;
	await viewer.refresh();
	run();
	assert.equal(viewer.movers.length, 2, "not blinked off while the day index is fetched again");
	assert.deepEqual(requests.filter(k => k.endsWith(".m.gz") || k.endsWith(".k.gz")), []);
});

test("a catalog that lands after close selects and subscribes to nothing", async () => {
	let release = () => {};
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const { viewer, lives } = setup(history(), undefined, key => (key === CATALOG ? held : Promise.resolve()));
	const refreshed = viewer.refresh();
	viewer.close();
	release();
	await refreshed;
	assert.equal(viewer.sel, undefined);
	assert.equal(lives.length, 0);
});

test("a live update that throws doesn't stop the later ones", async () => {
	const { viewer, settle, lives } = setup(new Map([[CATALOG, catalog([[], [], [], [], []])]]));
	await viewer.refresh();
	await settle();
	const T = 2_000_000_000;
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: 5 as never });
	lives[0].on({ t: T, map: "i-1", surface: "nauvis", movers: [["p:bob", "p", "player", "bob", 0, 0, 0, 0, 0, T]] });
	await settle();
	assert.equal(viewer.present.size, 1);
});

test("a forward step reloads when a change file closed since the held index (it was the open window)", async () => {
	const files = history();
	files.set(indexKey(A0), { snaps: [100], changes: [[50, 50]] });
	const { viewer, settle } = setup(files);
	viewer.seek(200);
	await viewer.refresh();
	await settle();
	assert.deepEqual(colour(viewer, A0, 0), BLUE, "the snapshot; file 150 isn't listed yet");
	files.set(indexKey(A0), { snaps: [100], changes: [[50, 50], [150, 160]] });
	await viewer.refresh();
	viewer.seek(210);
	await settle();
	assert.deepEqual(colour(viewer, A0, 0), GREEN, "record 150 is in (100, 210]");
});

test("choose passes over a map or surface whose forces are empty", () => {
	const cat = catalog([[], [], [], [], []]);
	const maps = cat.maps;
	const bare = { ...maps["i-1"].surfaces.nauvis, forces: {} };
	cat.maps = { "i-0": { ...maps["i-1"], surfaces: { nauvis: bare } }, ...maps };
	const want = { map: "i-1", surface: "nauvis", force: "player", instance: undefined };
	assert.deepEqual(choose(cat), want);
	assert.deepEqual(choose(cat, { map: "i-0" }), want);
});
