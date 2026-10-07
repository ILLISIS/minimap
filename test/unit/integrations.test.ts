import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { edgeLines, mapInfo, mapOf, tileOf, ueApi, type EdgeRecordLike, type Tile } from "../../integrations.js";
import { tempDir } from "./fakes.js";

const tile = (x: number, world = "w 1"): Tile => ({ world, x, y: 0, size: 512, surface: "nauvis" });

test("gridworld.tile: absent, null, or a GW-less controller's 'No field named' all mean no tile (§7.3)", () => {
	const noField = {
		get: (): unknown => {
			throw new Error("No field named 'gridworld.tile'");
		},
	};
	assert.equal(tileOf(noField), null);
	assert.equal(tileOf({ get: () => null }), null);
	assert.deepEqual(tileOf({ get: () => tile(1) }), tile(1));
});

test("maps (K9, K32): a tile's tile surface is its world's; its other surfaces and standalone instances are their own",
	() => {
		assert.equal(mapOf({ id: 5, tile: tile(0) }, "nauvis"), "gw-w~201");
		assert.equal(mapOf({ id: 5, tile: tile(0) }, "vulcanus"), "i-5");
		assert.equal(mapOf({ id: 6, tile: null }, "nauvis"), "i-6");
		// §22.1 (M14): a surface the instance's mm.surfaces marked tiled is its world's, on a tile only
		assert.equal(mapOf({ id: 5, tile: tile(0) }, "vulcanus", new Set(["vulcanus"])), "gw-w~201");
		assert.equal(mapOf({ id: 5, tile: tile(0) }, "platform-1", new Set(["vulcanus"])), "i-5");
		assert.equal(mapOf({ id: 6, tile: null }, "vulcanus", new Set(["vulcanus"])), "i-6", "no tile, no world");
	});

test("without GW: one i-<id> map per instance; with it, a world map with each tile's bounds (§12.2)", () => {
	assert.deepEqual(mapInfo([{ id: 1, name: "a", tile: null }, { id: 2, name: "b", tile: null }]), {
		"i-1": { title: "a", instances: { 1: { name: "a" } } },
		"i-2": { title: "b", instances: { 2: { name: "b" } } },
	});
	const maps = mapInfo([
		{ id: 3, name: "gridworld_0_0", tile: tile(0) },
		{ id: 4, name: "gridworld_1_0", tile: tile(1) },
	]);
	assert.deepEqual(maps["gw-w~201"], {
		title: "Gridworld w 1", tileSize: 512,
		instances: {
			3: { name: "gridworld_0_0", bounds: [-256, -256, 256, 256] },
			4: { name: "gridworld_1_0", bounds: [256, -256, 768, 256] },
		},
	});
	assert.ok(maps["i-3"], "a tile's other surfaces still have the instance's map");
});

test("edge lines (§12.3): each live side along rot(1, 0, facing); gridworld's coincident sides draw once", () => {
	const side = (instanceId: number, origin: [number, number], facing: number) => ({
		instanceId, surface: "nauvis", origin, facing,
	});
	const records: EdgeRecordLike[] = [
		{ deleted: false, length: 512, a: side(3, [256, -256], 4), b: side(4, [256, 256], 12) },
		{ deleted: false, length: 64, a: side(7, [0, 5000], 0), b: side(8, [64, 5000], 8) },
		{ deleted: true, length: 64, a: side(7, [0, 6000], 0), b: side(8, [64, 6000], 8) },
	];
	const map = (instance: number) => (instance === 3 || instance === 4 ? "gw-w1" : `i-${instance}`);
	assert.deepEqual(edgeLines(records, map), new Map([
		["gw-w1|nauvis", [[256, -256, 256, 256]]],
		["i-7|nauvis", [[0, 5000, 64, 5000]]],
		["i-8|nauvis", [[0, 5000, 64, 5000]]],
	]));
});

test("UE's edgeApi() through UE's own module file; undefined without UE, before it's ready, or without the file",
	async () => {
		assert.equal(await ueApi([{ name: "gridworld", requirePath: "/nowhere" }]), undefined);
		const write = async (body: string) => {
			const dir = await tempDir("ue");
			await mkdir(join(dir, "dist", "node", "edges"), { recursive: true });
			await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
			await writeFile(join(dir, "dist", "node", "edges", "index.js"), body);
			return [{ name: "universal_edges", requirePath: dir }];
		};
		const ready = await write("export function edgeApi() { return { list: () => [\"edge\"] }; }");
		assert.deepEqual((await ueApi(ready))?.list(), ["edge"]);
		const early = await write("export function edgeApi() { throw new Error(\"not ready\"); }");
		assert.equal(await ueApi(early), undefined);
		assert.equal(await ueApi([{ name: "universal_edges", requirePath: await tempDir("ue") }]), undefined);
	});
