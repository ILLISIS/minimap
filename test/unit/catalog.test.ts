import { test } from "node:test";
import assert from "node:assert/strict";
import type { Quad } from "../../shared/keys.js";
import { Catalog } from "../../store/catalog.js";

test("the catalog (§8.8) lists what a viewer may fetch, with the game's names (Review Focus 4)", () => {
	const catalog = new Catalog();
	const keys = [
		"gw-w1/nauvis/player/0/0_0/index.json.gz", "gw-w1/nauvis/player/0/0_0/1759500000000.c.gz",
		"gw-w1/nauvis/player/0/0_0/1759500060000.s.gz", "gw-w1/nauvis/player/0/1_0/index.json.gz",
		"gw-w1/nauvis/player/1/0_0/index.json.gz", "gw-w1/nauvis/player/1/0_0/1759500060000.c.gz",
		"gw-w1/nauvis/player/2/0_0/index.json.gz", "gw-w1/nauvis/player/3/0_0/index.json.gz",
		"gw-w1/nauvis/player/4/0_0/index.json.gz", "gw-w1/nauvis/player/tags.json.gz",
		"gw-w1/nauvis/player/0/0_0/recipes.json.gz", "gw-w1/nauvis/player/0/5_5/recipes.json.gz",
		"gw-w1/nauvis/m/2026-10-05.json.gz", "gw-w1/nauvis/m/1759499990000.m.gz", "gw-w1/nauvis/m/1759500060000.k.gz",
		"i-7/Bob~27s~20base/m/0/-1_0/index.json.gz", "i-7/Bob~27s~20base/m/0/-1_0/1759600000000.c.gz",
	];
	for (const key of keys) {
		catalog.add(key);
	}
	const quad = (a: number, b: number, c: number, d: number): Quad => [a, b, c, d];
	const info = {
		"gw-w1": {
			title: "Gridworld w1", tileSize: 512,
			instances: { 1481520497: { name: "gridworld_0_0", bounds: quad(-256, -256, 256, 256) } },
		},
	};
	const edges = new Map([["gw-w1|nauvis", [quad(256, -256, 256, 256)]]]);
	const assets = { spritesheet: "spritesheet.3f9a1c.png", metadata: "metadata.77aa01.json", locale: "locale.1.json" };
	assert.equal("icons" in catalog.json(info, edges, 1, 1), false, "no export, no icons (controller ruling R2)");
	assert.deepEqual(catalog.json(info, edges, 1759600500000, 300_000, assets), {
		updated: 1759600500000, window_ms: 300_000, live_ms: 5000,
		icons: { png: "icons/spritesheet.3f9a1c.png", json: "icons/metadata.77aa01.json" },
		maps: {
			"gw-w1": {
				...info["gw-w1"],
				surfaces: {
					nauvis: {
						first: 1759499990000, live: true, days: ["2026-10-05"], edges: [[256, -256, 256, 256]],
						forces: { player: { tags: true, areas: [["0_0", "1_0"], ["0_0"], ["0_0"], ["0_0"], ["0_0"]] } },
					},
				},
			},
			"i-7": {
				title: "i-7", instances: {},
				surfaces: {
					"Bob's base": {
						first: 1759600000000, live: false, days: [], edges: [],
						forces: { m: { tags: false, areas: [["-1_0"], [], [], [], []] } },
					},
				},
			},
		},
	});
});
