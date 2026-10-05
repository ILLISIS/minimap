import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Stamped } from "../../contracts.js";
import type { Instance } from "../../integrations.js";
import {
	CATALOG, indexKey, utcDay, type AreaIndex, type Catalog, type DayIndex, type Quad,
} from "../../shared/keys.js";
import { Store, endsPlayers, luaDrops, nextClose } from "../../store/index.js";
import { ownerDrops, samplesTaken } from "../../store/movers.js";
import { fakeLogger, tempDir, type Line } from "./fakes.js";

const T = Date.UTC(2026, 9, 5, 12);
const flat = (colour: number) => deflateSync(Buffer.alloc(2048, Buffer.from([colour % 256, Math.floor(colour / 256)])))
	.toString("base64");
const solo: Instance = { id: 3, name: "solo", tile: null };
const tile = (id: number, x: number): Instance => ({
	id, name: `gridworld_${x}_0`, tile: { world: "w1", x, y: 0, size: 512, surface: "nauvis" },
});
const chunk = (t: number, cx: number, colour: number, s = "nauvis"): Stamped => ({
	type: "mm.chunk", s, f: "player", x: cx, y: 0, d: flat(colour), t,
});
const sample = (t: number, j: string, x: number): Stamped => ({
	type: "mm.move", s: "nauvis", t,
	m: [j.startsWith("p:")
		? { j, k: "p", f: "player", name: j.slice(2), x, y: 0, vx: 0, vy: 0 }
		: { j, k: "t", f: "player", name: "locomotive", x, y: 0, vx: 1, vy: 0, n: 3 }],
});

async function setup(instances: Instance[], edges = new Map<string, Quad[]>()) {
	let now = T;
	const lines: Line[] = [];
	const cluster = {
		instance: (id: number) => instances.find(i => i.id === id),
		instances: () => instances,
		edges: async () => edges,
		assets: () => undefined,
	};
	const store = new Store(await tempDir("store"), cluster, fakeLogger(lines), () => 300, () => now);
	await store.load();
	const at = (t: number) => {
		now = t;
	};
	return { store, cluster, lines, at, json: <J>(key: string) => store.disk.json<J>(key) };
}

test("closes fall on multiples of W, W read at each close: 300 → 60 → 300 s (§8.10, M13)", () => {
	assert.equal(nextClose(T + 10_000, 300_000), T + 300_000);
	assert.equal(nextClose(T + 300_004, 60_000), T + 360_000, "W set to 60 s: it applies from the next window");
	assert.equal(nextClose(T + 360_002, 60_000), T + 420_000);
	assert.equal(nextClose(T + 420_001, 300_000), T + 600_000, "back to 300 s: the next multiple of 300 s");
	assert.equal(nextClose(T + 600_000, 300_000), T + 900_000, "a close exactly on a multiple waits a whole window");
});

test("closes at W's changing times keep files, indexes and day indexes consistent (§16.2)", async () => {
	const { store, at, json } = await setup([solo]);
	const closes = [T + 300_004, T + 360_002, T + 420_001, T + 600_003];
	let t = T + 1000;
	for (const [i, c] of closes.entries()) {
		await store.ingest(3, [chunk(t, i, i + 1), sample(t, "3.1.1", i)]);
		at(c);
		await store.closeWindow();
		t = c + 1000;
	}
	const keys = await store.keys();
	const firsts = [T + 1000, T + 301_004, T + 361_002, T + 421_001];
	const index = (await json<AreaIndex>("i-3/nauvis/player/0/0_0/index.json.gz"))!;
	assert.deepEqual(index.changes.map(([first]) => first), firsts);
	for (const first of firsts) {
		assert.ok(keys.includes(`i-3/nauvis/player/0/0_0/${first}.c.gz`), `change file ${first}`);
	}
	const moves = keys.filter(k => k.endsWith(".m.gz")).map(k => Number(k.split("/").pop()!.split(".")[0]));
	assert.deepEqual(moves, firsts, "window files named by their first sample");
	const day = (await json<DayIndex>(`i-3/nauvis/m/${utcDay(T)}.json.gz`))!;
	assert.deepEqual(day.windows.map(([first]) => first), firsts, "the day index lists every window file");
	assert.deepEqual(day.keys, [T + 300_004], "one keyframe: every close was in one UTC hour (K12)");
});

test("each close's keys reach the listeners in K36's upload order, the catalog last", async () => {
	const { store, at } = await setup([solo]);
	const seen: string[][] = [];
	store.onWindowClosed(keys => {
		seen.push(keys);
	});
	await store.ingest(3, [
		chunk(T + 1000, 0, 0x1234),
		sample(T + 1000, "3.1.1", 5),
		{ type: "mm.tag", s: "nauvis", f: "player", n: 1, x: 1, y: 2, icon: "", text: "a", t: T + 1000 },
		{ type: "mm.recipe", s: "nauvis", f: "player", u: 9, x: 3, y: 4, r: "iron-gear-wheel", q: "", t: T + 1000 },
	]);
	at(T + 300_000);
	const keys = await store.closeWindow();
	assert.deepEqual(seen, [keys]);
	const kinds = [
		/\.[cs]\.gz$/, /\/index\.json\.gz$/, /\.[mk]\.gz$/, /\/m\/[\d-]+\.json\.gz$/, /\/(tags|recipes)\.json\.gz$/,
	];
	const ranks = keys.slice(0, -1).map(k => kinds.findIndex(r => r.test(k)));
	assert.ok(ranks.every(r => r >= 0), keys.join("\n"));
	assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), keys.join("\n"));
	assert.equal(keys.at(-1), CATALOG);
	assert.ok(keys.includes("i-3/nauvis/player/0/0_0/recipes.json.gz"));
	assert.deepEqual((await store.keys()).filter(k => !keys.includes(k)), [], "keys() lists exactly what is on disk");
	assert.equal(store.path(CATALOG), join(store.disk.root, "maps.json.gz"));
	const flag = async () => (await store.disk.json<AreaIndex>("i-3/nauvis/player/0/0_0/index.json.gz"))!.recipes;
	assert.equal(await flag(), undefined, "the index names its recipes file one close later (plan ruling 24)");
	at(T + 600_000);
	await store.closeWindow();
	assert.equal(await flag(), true, "§8.5");
});

test("a recipes file the last close before a stop wrote is flagged at the first close after the start (ruling 24)",
	async () => {
		const { store, cluster } = await setup([solo]);
		await store.ingest(3, [
			{ type: "mm.recipe", s: "nauvis", f: "player", u: 9, x: 3, y: 4, r: "iron-gear-wheel", q: "", t: T + 1000 },
		]);
		await store.ingest(3, [chunk(T + 1001, 40, 5)]);
		await store.close();
		const index = "i-3/nauvis/player/0/0_0/index.json.gz";
		assert.equal((await store.disk.json<AreaIndex>(index))?.recipes, undefined);
		const again = new Store(store.disk.root, cluster, fakeLogger(), () => 300, () => T + 600_000);
		await again.load();
		await again.closeWindow();
		assert.equal((await again.disk.json<AreaIndex>(index))!.recipes, true);
		assert.deepEqual(again.liveChanged(), [], "no movement on disk: no live file to put");
		const catalog = (await again.disk.json<Catalog>(CATALOG))!;
		assert.deepEqual(catalog.maps["i-3"].surfaces.nauvis.forces.player.areas[0], ["0_0", "3_0"],
			"the area the restarted store never touched is still listed");
	});

test("a corrupt index fails its recipes flag once, not every close; the area is kept for the next (review fix 4)",
	async () => {
		const { store, cluster, lines } = await setup([solo]);
		await store.ingest(3, [
			{ type: "mm.recipe", s: "nauvis", f: "player", u: 9, x: 3, y: 4, r: "iron-gear-wheel", q: "", t: T + 1000 },
			chunk(T + 1000, 0, 1),
		]);
		await store.close();
		const key = "i-3/nauvis/player/0/0_0/index.json.gz";
		const again = new Store(store.disk.root, cluster, fakeLogger(lines), () => 300, () => T + 600_000);
		await again.load();
		await writeFile(store.path(key), "not gzip");
		const keys = await again.closeWindow();
		assert.ok(keys.includes(CATALOG), "the close still finished");
		const errors = lines.filter(l => l.message === "minimap.store write_failed");
		assert.deepEqual(errors.map(l => l.meta.key), [key]);
		await again.closeWindow();
		const failures = lines.filter(l => l.message === "minimap.store write_failed");
		assert.equal(failures.length, 2, "kept: retried next close");
	});

test("mm.surfaces begins a resync: the mover and tag it didn't re-send are closed by mm.resynced", async () => {
	const { store } = await setup([solo]);
	const tag = (n: number, t: number): Stamped => (
		{ type: "mm.tag", s: "nauvis", f: "player", n, x: 1, y: 2, icon: "", text: "a", t });
	await store.ingest(3, [sample(T + 1, "3.1.1", 1), sample(T + 1, "3.2.2", 2), tag(1, T + 1), tag(2, T + 1)]);
	await store.liveChanged();
	const updates = await store.ingest(3, [
		{ type: "mm.surfaces", list: [{ name: "nauvis", tile: false }], t: T + 2 },
		sample(T + 3, "3.1.1", 1), tag(1, T + 3),
		{ type: "mm.resynced", trace: "r.1", counts: {}, t: T + 4 },
	]);
	assert.deepEqual(updates.map(u => u.gone), [["3.2.2"]]);
	assert.deepEqual(updates[0].tags?.map(v => [v[1], v[4]]), [[2, T + 4]], "tag 2 closed at the resync");
});

test("a stop and a host crash (status unknown) both end the instance's players (§7.3)", () => {
	assert.deepEqual(["stopped", "unknown", "running", "starting"].map(endsPlayers), [true, true, false, false]);
});

test("a tile surface lands on its world's map, the rest on the instance's own (K9, K32), as the catalog says",
	async () => {
		const edges = new Map<string, Quad[]>([["gw-w1|nauvis", [[256, -256, 256, 256]]]]);
		const { store, at, json } = await setup([tile(1, 0), tile(2, 1), solo], edges);
		await store.ingest(1, [chunk(T + 1, 0, 1), chunk(T + 2, 0, 2, "platform-1")]);
		await store.ingest(2, [chunk(T + 3, 10, 3)]);
		await store.ingest(3, [chunk(T + 4, 0, 4)]);
		at(T + 300_000);
		await store.closeWindow();
		const catalog = (await json<Catalog>(CATALOG))!;
		assert.deepEqual(Object.keys(catalog.maps).sort(), ["gw-w1", "i-1", "i-3"]);
		const world = catalog.maps["gw-w1"];
		assert.deepEqual(world.surfaces.nauvis.forces.player.areas[0], ["0_0", "1_0"], "one level-0 area per tile");
		assert.deepEqual(world.instances, {
			1: { name: "gridworld_0_0", bounds: [-256, -256, 256, 256] },
			2: { name: "gridworld_1_0", bounds: [256, -256, 768, 256] },
		});
		assert.deepEqual([world.tileSize, world.surfaces.nauvis.edges], [512, [[256, -256, 256, 256]]]);
		assert.deepEqual(Object.keys(catalog.maps["i-1"].surfaces), ["platform-1"]);
		assert.deepEqual([catalog.updated, catalog.window_ms, catalog.live_ms], [T + 300_000, 300_000, 5000]);
	});

test("Clock (C8): equal stamps from two instances land at one slider time", async () => {
	const { store, at, json } = await setup([tile(1, 0), tile(2, 1)]);
	await store.ingest(1, [chunk(T + 5000, 0, 1), sample(T + 5000, "1.1.1", 0)]);
	await store.ingest(2, [chunk(T + 5000, 10, 2), sample(T + 5000, "2.1.1", 300)]);
	at(T + 300_000);
	const keys = await store.closeWindow();
	assert.ok(keys.includes(`gw-w1/nauvis/player/0/0_0/${T + 5000}.c.gz`));
	assert.ok(keys.includes(`gw-w1/nauvis/player/0/1_0/${T + 5000}.c.gz`));
	const win = (await json<{ s: number[][] }>(`gw-w1/nauvis/m/${T + 5000}.m.gz`))!;
	assert.deepEqual(win.s.map(r => r[1]), [0, 0], "both samples at dt 0 of one window file");
});

test("ingest: one live update per map surface; mm.adopt logs the owner change; metrics count; a stop ends players",
	async () => {
		const { store, lines } = await setup([solo, { id: 4, name: "other", tile: null }]);
		const taken = samplesTaken.get();
		const drops = ownerDrops.get();
		const updates = await store.ingest(3, [
			chunk(T + 1, 0, 7),
			{ type: "mm.chunk", s: "nauvis", f: "player", x: 1, y: 0, t: T + 2 },
			sample(T + 3, "p:alice", 1),
			sample(T + 3, "3.1.1", 2),
			{ type: "mm.resynced", trace: "r.1", counts: { drops: 4 }, t: T + 4 },
		]);
		assert.deepEqual(updates.map(u => [u.t, u.map, u.surface, u.chunks?.length, u.movers?.length]),
			[[T, "i-3", "nauvis", 1, 2]], "a never-charted chunk deleted is no change");
		assert.equal(luaDrops.labels("3").get(), 4);
		assert.equal(samplesTaken.get() - taken, 2);
		assert.deepEqual(store.liveChanged().map(x => [x.map, x.surface, x.movers.length]), [["i-3", "nauvis", 2]]);
		assert.deepEqual(store.liveChanged(), []);
		await store.ingest(4, [sample(T + 5, "3.1.1", 9)]);
		assert.equal(ownerDrops.get() - drops, 1, "instance 4 doesn't own 3.1.1 (K28)");
		await store.ingest(4, [{ type: "mm.adopt", j: "3.1.1", trace: "x.7", t: T + 6 }]);
		assert.deepEqual(lines.filter(l => l.message === "minimap.journey owner").map(l => [l.level, l.meta]), [
			["verbose", {
				op: "minimap.journey", phase: "owner", trace: "x.7", journey: "3.1.1", instance: 4, previous: 3,
			}],
		]);
		const stopped = await store.instanceStopped(3);
		assert.deepEqual(stopped.map(u => u.gone), [["p:alice"]], "players only; 3.1.1 is instance 4's now");
	});

test("the shutdown close (§8.10) writes the open window, notifies and stops the timer", async (t: TestContext) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { store, lines } = await setup([solo]);
	const seen: string[][] = [];
	store.onWindowClosed(keys => {
		seen.push(keys);
	});
	store.start();
	await store.ingest(3, [chunk(T + 1, 0, 7)]);
	await store.close();
	assert.equal(seen.length, 1);
	assert.ok(seen[0].includes(`i-3/nauvis/player/0/0_0/${T + 1}.c.gz`));
	const closed = lines.filter(l => l.message === "minimap.window closed");
	assert.deepEqual(closed.map(l => [l.level, l.meta.files, l.meta.samples]), [["verbose", seen[0].length, 0]]);
	t.mock.timers.tick(300_000);
	await store.ingest(3, []); // lets a surviving timer's close run
	assert.equal(seen.length, 1, "the timer was cleared");
});

test("an unreadable tags, recipes or index file doesn't stop load(); a corrupt index loses only its item", async () => {
	const { store, lines } = await setup([solo]);
	const root = store.disk.root;
	const bad = async (key: string) => {
		await mkdir(dirname(join(root, key)), { recursive: true });
		await writeFile(join(root, key), "not gzip");
	};
	await bad("i-3/nauvis/player/tags.json.gz");
	await bad("i-3/nauvis/player/0/6_6/recipes.json.gz");
	await bad("i-3/nauvis/player/0/6_6/index.json.gz");
	await bad("i-3/nauvis/player/0/0_0/index.json.gz");
	const cluster = {
		instance: () => solo, instances: () => [solo], edges: async () => new Map(), assets: () => undefined,
	};
	const again = new Store(root, cluster, fakeLogger(lines), () => 300, () => T);
	await again.load();
	assert.ok(lines.some(l => l.level === "error" && l.meta.key === "i-3/nauvis/player/tags.json.gz"));
	assert.ok(lines.every(l => !JSON.stringify(l).includes("not gzip")), "no file contents in the log");
	await again.ingest(3, [chunk(T + 1000, 0, 1), sample(T + 1000, "3.1.1", 5)]);
	const movers = again.subscribed("i-3|nauvis").movers?.map(m => m[0]);
	assert.deepEqual(movers, ["3.1.1"], "the mover after the failed chunk");
	assert.ok(lines.some(l => l.level === "warn" && l.message.includes("item failed")));
});
