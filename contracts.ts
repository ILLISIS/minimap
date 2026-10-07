import { Type, type Static } from "@sinclair/typebox";

// The minimap's wire shapes, pinned for every plan (spec K36; plan A Task 1). Lua prints one LuaBatch per line on
// minimap:out (§6.10); the instance plugin forwards each message but `trace` as a Stamped item (§7.3); the controller
// sends the Tag, Recipe and LiveMover tuples to the viewers (§8.9, §9.2, §10.6). Lua checks what it reads over RCON;
// TypeScript validates everything that arrives from Lua against these before use.

const Kind = Type.Union([Type.Literal("t"), Type.Literal("v"), Type.Literal("p")]);

/** A chunk's chart: x, y are chunk coordinates; d is helpers.encode_string of the 2,048 bytes; no d: deleted. */
export const ChunkMsg = Type.Object({
	type: Type.Literal("mm.chunk"),
	s: Type.String(),
	f: Type.String(),
	x: Type.Integer(),
	y: Type.Integer(),
	d: Type.Optional(Type.String()),
});
export type ChunkMsg = Static<typeof ChunkMsg>;

/**
 * One mover's sample, in tiles and tiles a second. n: a train's carriages. name: the leading carriage's or vehicle's
 * prototype, or the player's name. j: the journey, or "p:<name>" for a player.
 */
export const MoverSample = Type.Object({
	j: Type.String(),
	k: Kind,
	f: Type.String(),
	name: Type.String(),
	x: Type.Number(),
	y: Type.Number(),
	vx: Type.Number(),
	vy: Type.Number(),
	n: Type.Optional(Type.Integer()),
	/** §22.2: a train's carriages from its leading end: "L" locomotive, "F" fluid, "A" artillery, else "C". */
	o: Type.Optional(Type.String({ pattern: "^[LCFA]{0,200}$" })),
	/** §22.2: a train's leading locomotive's colour, "rrggbb". */
	c: Type.Optional(Type.String({ pattern: "^[0-9a-f]{6}$" })),
});
export type MoverSample = Static<typeof MoverSample>;

export const MoverGone = Type.Object({ j: Type.String(), gone: Type.Literal(true) });
export type MoverGone = Static<typeof MoverGone>;

export const MoveMsg = Type.Object({
	type: Type.Literal("mm.move"),
	s: Type.String(),
	m: Type.Array(Type.Union([MoverSample, MoverGone])),
});
export type MoveMsg = Static<typeof MoveMsg>;

/** A crossing's destination took journey j (§13, K28), under the crossing's trace. */
export const AdoptMsg = Type.Object({ type: Type.Literal("mm.adopt"), j: Type.String(), trace: Type.String() });
export type AdoptMsg = Static<typeof AdoptMsg>;

/** A chart tag's new state; no x: removed. icon is "<signal type>/<name>", or "" when none. */
export const TagMsg = Type.Object({
	type: Type.Literal("mm.tag"),
	s: Type.String(),
	f: Type.String(),
	n: Type.Integer(),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	icon: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
});
export type TagMsg = Static<typeof TagMsg>;

/** A machine's recipe and quality; no r: removed (no recipe, or the machine is gone). u: its unit number. */
export const RecipeMsg = Type.Object({
	type: Type.Literal("mm.recipe"),
	s: Type.String(),
	f: Type.String(),
	u: Type.Integer(),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	r: Type.Optional(Type.String()),
	q: Type.Optional(Type.String()),
});
export type RecipeMsg = Static<typeof RecipeMsg>;

/**
 * Each surface's name and whether it is one of the tile's (§6.7 step 1, §22.1). created: one surface made mid-game,
 * which starts no resync (plan F ruling P3).
 */
export const SurfacesMsg = Type.Object({
	type: Type.Literal("mm.surfaces"),
	list: Type.Array(Type.Object({ name: Type.String(), tile: Type.Boolean() })),
	created: Type.Optional(Type.Literal(true)),
});
export type SurfacesMsg = Static<typeof SurfacesMsg>;

/** The end of a resync (§6.7 step 6). counts.drops = Lua's dropped pushes and messages. */
export const ResyncedMsg = Type.Object({
	type: Type.Literal("mm.resynced"),
	trace: Type.String(),
	counts: Type.Record(Type.String(), Type.Integer()),
});
export type ResyncedMsg = Static<typeof ResyncedMsg>;

/**
 * A log line: the instance logs it as "<op> <phase>" with its other fields, reserved keys stripped, and never
 * forwards it. Other fields are allowed (TypeBox objects admit additional properties).
 */
export const TraceMsg = Type.Object({
	type: Type.Literal("trace"),
	op: Type.String(),
	phase: Type.String(),
	level: Type.Optional(
		Type.Union([Type.Literal("info"), Type.Literal("verbose"), Type.Literal("warn"), Type.Literal("error")]),
	),
});
export type TraceMsg = Static<typeof TraceMsg>;

export const LuaMsg = Type.Union([ChunkMsg, MoveMsg, AdoptMsg, TagMsg, RecipeMsg, SurfacesMsg, ResyncedMsg, TraceMsg]);
export type LuaMsg = Static<typeof LuaMsg>;

/**
 * One line on minimap:out (§6.10): tick is the flush tick, for the harness's per-tick checks; the instance
 * ignores it.
 */
export const LuaBatch = Type.Object({ tick: Type.Integer(), msgs: Type.Array(LuaMsg) });
export type LuaBatch = Static<typeof LuaBatch>;

const t = { t: Type.Number() };

/** A LuaMsg other than trace, with t = Date.now() at the instance (§7.3, K8). */
export const Stamped = Type.Union([
	Type.Object({ ...ChunkMsg.properties, ...t }),
	Type.Object({ ...MoveMsg.properties, ...t }),
	Type.Object({ ...AdoptMsg.properties, ...t }),
	Type.Object({ ...TagMsg.properties, ...t }),
	Type.Object({ ...RecipeMsg.properties, ...t }),
	Type.Object({ ...SurfacesMsg.properties, ...t }),
	Type.Object({ ...ResyncedMsg.properties, ...t }),
]);
export type Stamped = Static<typeof Stamped>;

const End = Type.Union([Type.Number(), Type.Null()]);

/** §8.9: [instance, tag_number, force, start, end|null, x, y, icon, text]. */
export const Tag = Type.Tuple([
	Type.Integer(), Type.Integer(), Type.String(), Type.Number(), End, Type.Number(), Type.Number(), Type.String(),
	Type.String(),
]);
export type Tag = Static<typeof Tag>;

/** §8.9: [instance, unit, force, start, end|null, x, y, recipe, quality]. */
export const Recipe = Type.Tuple([
	Type.Integer(), Type.Integer(), Type.String(), Type.Number(), End, Type.Number(), Type.Number(), Type.String(),
	Type.String(),
]);
export type Recipe = Static<typeof Recipe>;

/** §10.6: [id, kind, force, name, n, x, y, vx, vy, ts]; n = 0 when not a train. */
export const LiveMover = Type.Tuple([
	Type.String(), Kind, Type.String(), Type.String(), Type.Integer(), Type.Number(), Type.Number(), Type.Number(),
	Type.Number(), Type.Number(),
]);
export type LiveMover = Static<typeof LiveMover>;
