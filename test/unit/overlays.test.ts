import { test } from "node:test";
import assert from "node:assert/strict";
import type { RecipeMsg, TagMsg } from "../../contracts.js";
import { Disk } from "../../store/disk.js";
import { gather } from "../../store/index.js";
import { Overlays } from "../../store/overlays.js";
import { tempDir } from "./fakes.js";

const tag = (n: number, text?: string): TagMsg => (text === undefined
	? { type: "mm.tag", s: "nauvis", f: "player", n }
	: { type: "mm.tag", s: "nauvis", f: "player", n, x: 1, y: 2, icon: "item/iron-plate", text });
const recipe = (u: number, r?: string): RecipeMsg => (r === undefined
	? { type: "mm.recipe", s: "nauvis", f: "player", u }
	: { type: "mm.recipe", s: "nauvis", f: "player", u, x: 600.5, y: 10.5, r, q: "rare" });
const failed = (key: string, err: Error) => {
	throw new Error(`${key}: ${err.message}`);
};
const TAGS = "i-1/nauvis/player/tags.json.gz";
const RECIPES = "i-1/nauvis/player/0/1_0/recipes.json.gz";

test("tags (C5): a change closes the old version with its own text; a repeat is ignored; removal closes", async () => {
	const disk = new Disk(await tempDir("overlays"));
	const o = new Overlays(disk);
	const { out, updates } = gather();
	o.tag(1, "i-1", 1000, tag(7, "a"), out);
	o.tag(1, "i-1", 2000, tag(7, "a"), out);
	o.tag(1, "i-1", 3000, tag(7, "b"), out);
	o.tag(1, "i-1", 4000, tag(7), out);
	const { keys } = await o.close(failed);
	assert.deepEqual(keys, [TAGS]);
	assert.deepEqual(await disk.json(TAGS), [
		[1, 7, "player", 1000, 3000, 1, 2, "item/iron-plate", "a"],
		[1, 7, "player", 3000, 4000, 1, 2, "item/iron-plate", "b"],
	], "times are stamps, never 0 (C1)");
	assert.equal(updates.get("i-1|nauvis")?.tags?.length, 2, "each version once in the live event");
});

test("recipes (C1-C3): filed with their level-0 area, repeats ignored, removal by unit closes; a new file is reported",
	async () => {
		const disk = new Disk(await tempDir("overlays"));
		const o = new Overlays(disk);
		const { out } = gather();
		o.recipe(1, "i-1", 1000, recipe(55, "iron-gear-wheel"), out);
		o.recipe(1, "i-1", 2000, recipe(55, "iron-gear-wheel"), out);
		o.recipe(1, "i-1", 3000, recipe(55), out);
		const first = await o.close(failed);
		assert.deepEqual(first.keys, [RECIPES]);
		assert.deepEqual(first.areas, [{ map: "i-1", surface: "nauvis", force: "player", z: 0, ax: 1, ay: 0 }]);
		assert.deepEqual(await disk.json(RECIPES), [
			[1, 55, "player", 1000, 3000, 600.5, 10.5, "iron-gear-wheel", "rare"],
		]);
		o.recipe(1, "i-1", 4000, recipe(56, "copper-cable"), out);
		assert.deepEqual((await o.close(failed)).areas, [], "the file existed: its area is flagged already");
	});

test("mm.resynced closes the instance's open versions it didn't re-send since mm.surfaces, and no others", async () => {
	const disk = new Disk(await tempDir("overlays"));
	const o = new Overlays(disk);
	const { out } = gather();
	o.tag(1, "i-1", 1000, tag(7, "a"), out);
	o.tag(1, "i-1", 1000, tag(8, "b"), out);
	o.tag(2, "i-1", 1000, tag(9, "c"), out);
	o.resynced(1, 1500, out);
	o.begin(1);
	o.tag(1, "i-1", 2000, tag(7, "a"), out);
	o.resynced(1, 3000, out);
	await o.close(failed);
	const ends = (await disk.json<unknown[][]>(TAGS))!.map(v => [v[0], v[1], v[4]]);
	assert.deepEqual(ends, [[1, 7, null], [1, 8, 3000], [2, 9, null]]);
});

test("a restarted store keeps the open versions: the resync's repeats add nothing (Review Focus 3)", async () => {
	const disk = new Disk(await tempDir("overlays"));
	const { out } = gather();
	const before = new Overlays(disk);
	before.tag(1, "i-1", 1000, tag(7, "a"), out);
	before.recipe(1, "i-1", 1000, recipe(55, "iron-gear-wheel"), out);
	await before.close(failed);
	const after = new Overlays(disk);
	await after.load(await disk.keys());
	after.tag(1, "i-1", 5000, tag(7, "a"), out);
	after.recipe(1, "i-1", 5000, recipe(55, "iron-gear-wheel"), out);
	assert.deepEqual((await after.close(failed)).keys, [], "nothing changed");
	after.tag(1, "i-1", 6000, tag(7, "z"), out);
	await after.close(failed);
	const versions = (await disk.json<unknown[][]>(TAGS))!.map(v => [v[3], v[4], v[8]]);
	assert.deepEqual(versions, [[1000, 6000, "a"], [6000, null, "z"]]);
});

test("a tag re-sent with the same state but on another map is a new version there (§22.1)", async () => {
	const o = new Overlays(new Disk(await tempDir("overlays")));
	const { out, updates } = gather();
	o.tag(1, "i-1", 1000, tag(7, "a"), out);
	o.tag(1, "gw-w1", 2000, tag(7, "a"), out);
	assert.equal(updates.get("gw-w1|nauvis")?.tags?.length, 1, "opened on the world's map");
});
