// The key tree (spec §8.1, K9, K13): areas, blocks and pixels; names in keys; every key; the route's check;
// Cache-Control by kind (§10.4); and the JSON shapes of indexes and the catalog. Pure TypeScript for Node and the
// browser (Plan D's viewer imports it): no node: imports here.

/** An area's side in pixels, and the levels z = 0..4 (§8.1, §8.6). */
export const SIZE = 512;
export const LEVELS = 5;
/** A chunk's pixels, 32 × 32; from FULL changed pixels on, a record holds the whole block (§8.3). */
export const BLOCK = 1024;
export const FULL = 512;
export const CATALOG = "maps.json.gz";

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The area holding map coordinate x (or y) at level z, with the origin at -256 tiles (K9). */
export function area(x: number, z: number): number {
	return Math.floor((x + 256) / (SIZE * 2 ** z));
}

/** Map coordinate x's pixel within its area at level z: 0..511. */
export function pixel(x: number, z: number): number {
	return Math.floor((x + 256) / 2 ** z) - (SIZE * area(x, z));
}

/** The level-0 area holding chunk coordinate c. */
export function chunkArea(c: number): number {
	return Math.floor((c + 8) / 16);
}

/** Chunk (cx, cy)'s block in its level-0 area: 0..255, row-major (§8.1). */
export function chunkBlock(cx: number, cy: number): number {
	return mod(cx + 8, 16) + (16 * mod(cy + 8, 16));
}

/**
 * A name in a key (K13): [A-Za-z0-9_-] kept, every other UTF-8 byte as ~XX. encodeURIComponent leaves .!~*'() as
 * they are, so those are escaped by hand; then % becomes ~.
 */
export function name(s: string): string {
	return encodeURIComponent(s)
		.replace(/[.!~*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
		.replace(/%/g, "~");
}

export function unname(s: string): string {
	return decodeURIComponent(s.replace(/~/g, "%"));
}

/** One area: surface and force as the game names them; map is key-safe already (gw-<name(world)> or i-<id>). */
export type Area = { map: string; surface: string; force: string; z: number; ax: number; ay: number };

/** `<map>/<surface>/<force>/<z>/<ax>_<ay>`: the area's folder, and the open route's path (§9.1). */
export function areaKey(a: Area): string {
	return `${a.map}/${name(a.surface)}/${name(a.force)}/${a.z}/${a.ax}_${a.ay}`;
}

export const indexKey = (a: Area) => `${areaKey(a)}/index.json.gz`;
export const snapKey = (a: Area, t: number) => `${areaKey(a)}/${t}.s.gz`;
export const changeKey = (a: Area, t: number) => `${areaKey(a)}/${t}.c.gz`;
/** Recipes live with their level-0 area (§8.1). */
export const recipesKey = (a: Area) => `${areaKey(a)}/recipes.json.gz`;
export function tagsKey(map: string, surface: string, force: string): string {
	return `${map}/${name(surface)}/${name(force)}/tags.json.gz`;
}

export const dayKey = (map: string, surface: string, day: string) => `${map}/${name(surface)}/m/${day}.json.gz`;
export const moveKey = (map: string, surface: string, t: number) => `${map}/${name(surface)}/m/${t}.m.gz`;
export const keyframeKey = (map: string, surface: string, t: number) => `${map}/${name(surface)}/m/${t}.k.gz`;
export const liveKey = (map: string, surface: string) => `${map}/${name(surface)}/live.json.gz`;

/** The UTC day of a time, as day indexes are named (§8.7). */
export function utcDay(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

/** The HTTP route's check (§8.1): key characters only, and no `..` segment. */
export function validKey(key: string): boolean {
	return /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(key) && !key.split("/").includes("..");
}

/**
 * §10.4's Cache-Control, to follow "public, " (S3, Plan C) or "private, " (the route, §9.1). A day index is
 * immutable once final (§8.7): callers pass their clock less W as `asOf`, since the first close after midnight,
 * which writes it last, comes up to W after it (plan ruling 27).
 */
export function cacheControl(key: string, asOf: number): string {
	const day = /\/m\/(\d{4}-\d\d-\d\d)\.json\.gz$/.exec(key)?.[1];
	if (
		/\.[smck]\.gz$/.test(key)
		|| (day !== undefined && day < utcDay(asOf))
		|| /^(viewer-[^/]+\.js|icons\/.+)$/.test(key)
	) {
		return "max-age=31536000, immutable";
	}
	if (key.endsWith("/live.json.gz")) {
		return "max-age=5";
	}
	return key === "index.html" ? "max-age=300" : "max-age=60";
}

export type Quad = [number, number, number, number];
/** An area's index (§8.5): snapshot times, each change file's [first, last] record time, and recipes.json.gz. */
export type AreaIndex = { snaps: number[]; changes: [number, number][]; recipes?: true };
/** A UTC day's movement index (§8.7): window files' [first, last] sample times, and keyframe times. */
export type DayIndex = { windows: [number, number][]; keys: number[] };
export type MapInfo = {
	title: string;
	tileSize?: number;
	instances: Record<string, { name: string; bounds?: Quad }>;
};
export type SurfaceInfo = {
	first: number;
	live: boolean;
	days: string[];
	edges: Quad[];
	forces: Record<string, { tags: boolean; areas: string[][] }>;
};
/** maps.json.gz (§8.8): surface and force names as the game gives them; a viewer makes keys with name(). */
export type Catalog = {
	updated: number;
	window_ms: number;
	live_ms: number;
	icons?: { png: string; json: string };
	maps: Record<string, MapInfo & { surfaces: Record<string, SurfaceInfo> }>;
};
