import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "@clusterio/lib";
import { LiveMover, LuaBatch, LuaMsg, Recipe, Stamped, Tag } from "../../contracts.js";
import { MinimapDataEvent, MinimapLiveEvent } from "../../messages.js";

const valid = (schema: unknown) => lib.compile(schema as any);

test("LuaMsg accepts each message Lua prints, in its absent-field forms (spec §7.1)", () => {
	const ok = valid(LuaMsg);
	const msgs = [
		{ type: "mm.chunk", s: "nauvis", f: "player", x: -3, y: 4, d: "eJzt" },
		{ type: "mm.chunk", s: "nauvis", f: "player", x: -3, y: 4 },
		{ type: "mm.move", s: "nauvis", m: [
			{ j: "4242.600.32", k: "t", f: "player", name: "locomotive", x: 1.5, y: -2.25, vx: 18, vy: 0, n: 16 },
			{ j: "4242.600.33", k: "t", f: "player", name: "locomotive", x: 0, y: 0, vx: 0, vy: 0, n: 3, o: "LCF",
				c: "eb1200" },
			{ j: "p:bob", k: "p", f: "player", name: "bob", x: 0, y: 0, vx: 0, vy: 0 },
			{ j: "4242.600.v750", gone: true },
		] },
		{ type: "mm.adopt", j: "4242.600.32", trace: "7e570000.24" },
		{ type: "mm.tag", s: "nauvis", f: "player", n: 7, x: 10.5, y: 20, icon: "item/iron-plate", text: "hi" },
		{ type: "mm.tag", s: "nauvis", f: "player", n: 7 },
		{ type: "mm.recipe", s: "nauvis", f: "player", u: 99, x: 1.5, y: 1.5, r: "iron-gear-wheel", q: "rare" },
		{ type: "mm.recipe", s: "nauvis", f: "player", u: 99 },
		{ type: "mm.surfaces", list: [{ name: "nauvis", tile: true }, { name: "platform-1", tile: false }] },
		{ type: "mm.surfaces", list: [{ name: "gleba", tile: true }], created: true },
		{ type: "mm.resynced", trace: "ab.1", counts: { chunks: 3, movers: 0, tags: 0, machines: 0, drops: 0 } },
		{ type: "trace", op: "minimap.journey", phase: "adopted", level: "verbose", trace: "ab.2", journey: "x" },
	];
	for (const msg of msgs) {
		assert.ok(ok(msg), `${JSON.stringify(msg)}: ${JSON.stringify(ok.errors)}`);
	}
});

test("LuaMsg refuses a fractional chunk, an unknown kind, a tag without its number, an unknown type", () => {
	const ok = valid(LuaMsg);
	assert.equal(ok({ type: "mm.chunk", s: "nauvis", f: "player", x: 1.5, y: 0 }), false);
	const odd = { j: "a", k: "x", f: "p", name: "n", x: 0, y: 0, vx: 0, vy: 0 };
	assert.equal(ok({ type: "mm.move", s: "nauvis", m: [odd] }), false);
	assert.equal(ok({ type: "mm.tag", s: "nauvis", f: "player" }), false);
	assert.equal(ok({ type: "mm.nope" }), false);
	const train = { j: "a", k: "t", f: "p", name: "locomotive", x: 0, y: 0, vx: 0, vy: 0, n: 1 };
	assert.equal(ok({ type: "mm.move", s: "nauvis", m: [{ ...train, c: "red" }] }), false, "a colour not rrggbb");
	assert.equal(ok({ type: "mm.move", s: "nauvis", m: [{ ...train, o: "LX" }] }), false, "a kind not L, C, F or A");
	assert.equal(valid(LuaBatch)({ tick: 5, msgs: [{ type: "mm.adopt", j: "a", trace: "b" }] }), true);
});

test("Stamped is a LuaMsg other than trace, with t; MinimapDataEvent carries them", () => {
	const ok = valid(Stamped);
	assert.equal(ok({ type: "mm.adopt", j: "a", trace: "b", t: 1759600000000 }), true);
	assert.equal(ok({ type: "mm.adopt", j: "a", trace: "b" }), false, "no t");
	assert.equal(ok({ type: "trace", op: "o", phase: "p", t: 1 }), false, "never a trace");
	const items: Stamped[] = [{ type: "mm.chunk", s: "nauvis", f: "player", x: 0, y: 0, t: 5 }];
	assert.equal(valid(MinimapDataEvent.jsonSchema)(JSON.parse(JSON.stringify(new MinimapDataEvent(items)))), true);
	assert.deepEqual(MinimapDataEvent.fromJSON({ items }).items, items);
});

test("the tuples and MinimapLiveEvent (spec §8.9, §9.2, §10.6)", () => {
	const tag: Tag = [1481520497, 7, "player", 1759600000000, null, 10.5, 20, "item/iron-plate", "hi"];
	const recipe: Recipe = [1481520497, 99, "player", 1759600000000, 1759600060000, 1.5, 1.5, "iron-gear-wheel",
		"normal"];
	const mover: LiveMover = [
		"4242.600.32", "t", "player", "locomotive", 16, 1.5, -2, 18, 0, 1759600000000, "LCC", "eb1200",
	];
	assert.equal(valid(Tag)(tag), true);
	assert.equal(valid(Recipe)(recipe), true);
	assert.equal(valid(LiveMover)(mover), true);
	const ok = valid(MinimapLiveEvent.jsonSchema);
	const full = new MinimapLiveEvent(1759600000000, "gw-w1", "nauvis", [["player", 0, 0, "eJzt"]], [mover], ["p:bob"],
		[tag], [recipe]);
	assert.equal(ok(JSON.parse(JSON.stringify(full))), true, JSON.stringify(ok.errors));
	assert.equal(ok(JSON.parse(JSON.stringify(new MinimapLiveEvent(1, "i-4242", "nauvis")))), true, "only the head");
	assert.deepEqual(MinimapLiveEvent.fromJSON(JSON.parse(JSON.stringify(full))), full);
});
