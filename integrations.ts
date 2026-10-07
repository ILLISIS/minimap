// The optional integrations (spec §12, M10): gridworld's tile config, read from each instance's config, and UE's
// edges, through UE's own module file. Neither is a dependency; both are found at run time.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { name, type MapInfo, type Quad } from "./shared/keys.js";

/** The fields of gridworld.tile the minimap reads (gridworld/world/contracts.ts:8-16). */
export type Tile = { world: string; x: number; y: number; size: number; surface: string };
export type Instance = { id: number; name: string; tile: Tile | null };
/**
 * What the store reads of the cluster: controller.ts gives the controller's, the tests a fake. `assets` is the
 * default mod pack's export manifest's assets, for the catalog's icons (controller ruling R2).
 */
export type Cluster = {
	instance(id: number): Instance | undefined;
	instances(): Instance[];
	/** UE's edge lines by "<map>|<surface>", each side on the map `mapOf` gives it (the store's: §22.1). */
	edges(mapOf: (instance: number, surface: string) => string): Promise<Map<string, Quad[]>>;
	assets(): Record<string, string> | undefined;
};

/** The part of UE's edge record the lines need (universal_edges/edges/contracts.ts:10-16, 47-56). */
type SideLike = { instanceId: number; surface: string; origin: [number, number]; facing: number };
export type EdgeRecordLike = { deleted: boolean; length: number; a: SideLike; b: SideLike };
export type EdgeApiLike = { list(): EdgeRecordLike[] };

/**
 * gridworld.tile, or null: unset, or GW not loaded on the controller, which config.get reports as "No field named"
 * (clusterio/packages/lib/src/config/classes.ts:628-631).
 */
export function tileOf(config: { get(field: string): unknown }): Tile | null {
	try {
		return (config.get("gridworld.tile") as Tile | null) ?? null;
	} catch {
		return null;
	}
}

/**
 * K9, §22.1 (M14): a tile instance's tiled surfaces are its world's map: its tile.surface always, and each surface its
 * mm.surfaces marked tiled (`tiled`, plan F ruling P4). Every other surface, and every surface of an instance that is
 * no tile, is the instance's own.
 */
export function mapOf(
	instance: { id: number; tile: Tile | null }, surface: string, tiled?: ReadonlySet<string>,
): string {
	return instance.tile && (surface === instance.tile.surface || tiled?.has(surface))
		? `gw-${name(instance.tile.world)}`
		: `i-${instance.id}`;
}

/** The catalog's titles, tile sizes and bounds (§8.8, §12.2), from the instances as they are now. */
export function mapInfo(instances: Instance[]): Record<string, MapInfo> {
	const maps: Record<string, MapInfo> = {};
	for (const i of instances) {
		maps[`i-${i.id}`] = { title: i.name, instances: { [i.id]: { name: i.name } } };
		if (i.tile) {
			const { world, x, y, size } = i.tile;
			const h = size / 2;
			const key = `gw-${name(world)}`;
			maps[key] ??= { title: `Gridworld ${world}`, tileSize: size, instances: {} };
			// gridworld/world/grid.ts:14-17: [xT - T/2, xT + T/2) on each axis.
			maps[key].instances[i.id] = {
				name: i.name, bounds: [(x * size) - h, (y * size) - h, (x * size) + h, (y * size) + h],
			};
		}
	}
	return maps;
}

/** rot(1, 0, facing) (gridworld/world/grid.ts:25-26): the direction a side runs along its edge. */
const ALONG: Record<number, [number, number]> = { 0: [1, 0], 4: [0, 1], 8: [-1, 0], 12: [0, -1] };

/**
 * UE's live edges as lines (§12.3, M6): each side from its origin along rot(1, 0, facing) for the edge's length, on
 * its own instance's map and surface. Endpoints are put in order, so gridworld's coincident sides draw once.
 */
export function edgeLines(
	records: EdgeRecordLike[],
	mapOfSide: (instance: number, surface: string) => string,
): Map<string, Quad[]> {
	const lines = new Map<string, Map<string, Quad>>();
	for (const r of records.filter(x => !x.deleted)) {
		for (const side of [r.a, r.b]) {
			const [dx, dy] = ALONG[side.facing];
			const [x, y] = side.origin;
			const ends = [[x, y], [x + (r.length * dx), y + (r.length * dy)]]
				.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
			const line = [...ends[0], ...ends[1]] as Quad;
			const key = `${mapOfSide(side.instanceId, side.surface)}|${side.surface}`;
			if (!lines.has(key)) {
				lines.set(key, new Map());
			}
			lines.get(key)!.set(line.join(), line);
		}
	}
	return new Map([...lines].map(([key, m]) => [key, [...m.values()]]));
}

/**
 * UE's edgeApi() (universal_edges/edges/index.ts:32-37), imported from the file Clusterio's loader imports
 * (clusterio/packages/lib/src/plugin_loader.ts:84,109), so both share its singleton (§12.3). Undefined while UE
 * isn't in the plugin list, isn't loaded, or hasn't set its API: the store asks again at the next close.
 */
export async function ueApi(infos: { name: string; requirePath: string }[]): Promise<EdgeApiLike | undefined> {
	const ue = infos.find(p => p.name === "universal_edges");
	if (!ue) {
		return undefined;
	}
	try {
		const mod = await import(pathToFileURL(path.posix.join(ue.requirePath, "dist/node/edges/index.js")).href);
		return mod.edgeApi() as EdgeApiLike;
	} catch {
		return undefined;
	}
}
