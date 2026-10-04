import { Type, type Static } from "@sinclair/typebox";
import { LiveMover, Recipe, Stamped, Tag } from "./contracts.js";

/**
 * Instance → controller, once a second (spec §7.3): Lua's messages, stamped. The controller takes the instance from
 * the message's source, not from the payload.
 */
export class MinimapDataEvent {
	declare ["constructor"]: typeof MinimapDataEvent;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "minimap" as const;

	constructor(
		public items: Stamped[],
	) { }

	static jsonSchema = Type.Object({
		items: Type.Array(Stamped),
	});

	static fromJSON(json: Static<typeof MinimapDataEvent.jsonSchema>) {
		return new this(json.items);
	}
}

const LiveChunk = Type.Tuple([Type.String(), Type.Integer(), Type.Integer(), Type.String()]);

/**
 * Controller → control (spec §9.2, K24, K36), one per arriving MinimapDataEvent and map surface, by subscription with
 * the filter "<map>|<surface>". t: the controller's clock at broadcast. chunks: [force, cx, cy, d], d as Lua sent
 * it.
 */
export class MinimapLiveEvent {
	declare ["constructor"]: typeof MinimapLiveEvent;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static plugin = "minimap" as const;
	static permission = "minimap.view" as const;

	constructor(
		public t: number,
		public map: string,
		public surface: string,
		public chunks?: Static<typeof LiveChunk>[],
		public movers?: LiveMover[],
		public gone?: string[],
		public tags?: Tag[],
		public recipes?: Recipe[],
	) { }

	static jsonSchema = Type.Object({
		t: Type.Number(),
		map: Type.String(),
		surface: Type.String(),
		chunks: Type.Optional(Type.Array(LiveChunk)),
		movers: Type.Optional(Type.Array(LiveMover)),
		gone: Type.Optional(Type.Array(Type.String())),
		tags: Type.Optional(Type.Array(Tag)),
		recipes: Type.Optional(Type.Array(Recipe)),
	});

	static fromJSON(json: Static<typeof MinimapLiveEvent.jsonSchema>) {
		return new this(json.t, json.map, json.surface, json.chunks, json.movers, json.gone, json.tags, json.recipes);
	}
}
