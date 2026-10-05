import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tag } from "../../contracts.js";
import { Versions, iconIndex } from "../../web/view/overlays.js";

const tag = (start: number, end: number | null, text: string, force = "player"): Tag => [
	7, 3, force, start, end, 10, 20, "item/iron-plate", text,
];

test("tags at t: open versions of the selected force; a closed copy wins over an open one, in either order", () => {
	const tags = new Versions<Tag>();
	tags.add([tag(100, null, "a"), tag(100, null, "x", "enemy")], "player");
	assert.deepEqual(tags.at(150).map(v => v[8]), ["a"]);
	tags.add([tag(100, 200, "a"), tag(200, null, "b")], "player");
	tags.add([tag(100, null, "a")], "player"); // a tags file fetched before the close
	assert.deepEqual([tags.at(99), tags.at(150), tags.at(250)].map(l => l.map(v => v[8])), [[], ["a"], ["b"]]);
});

test("two states at one stamp: the empty first version never shows, the second does (§8.9)", () => {
	const tags = new Versions<Tag>();
	tags.add([tag(100, null, "a")], "player");
	tags.add([tag(100, 100, "a"), tag(100, null, "b")], "player");
	assert.deepEqual(tags.at(100).map(v => v[8]), ["b"]);
});

test("sprites by tag icon and recipe name; the export's virtual-signal is the signal type virtual", () => {
	const at = iconIndex({
		"item": [{ name: "iron-plate", icon: { x: 0, y: 32, size: 32 } }, { name: "no-icon" }],
		"virtual-signal": [{ name: "signal-A", icon: { x: 64, y: 0, size: 32 } }],
		"recipe": [{ name: "iron-gear-wheel", icon: { x: 32, y: 0, size: 32 } }],
	});
	assert.deepEqual([...at.keys()], ["item/iron-plate", "virtual/signal-A", "recipe/iron-gear-wheel"]);
});
