import { basename } from "node:path";
import { LEVELS, unname, type Catalog as CatalogJson, type MapInfo, type Quad } from "../shared/keys.js";

type Force = { tags: boolean; areas: Set<string>[] };
type Surf = { first: number; days: Set<string>; forces: Map<string, Force> };

const AREA = /^([^/]+)\/([^/]+)\/([^/]+)\/([0-4])\/(-?\d+_-?\d+)\/index\.json\.gz$/;
const TAGS = /^([^/]+)\/([^/]+)\/([^/]+)\/tags\.json\.gz$/;
const DAY = /^([^/]+)\/([^/]+)\/m\/(\d{4}-\d\d-\d\d)\.json\.gz$/;
/** A level-0 change file or a movement window: the earliest names the surface's first time. */
const FIRST = /^([^/]+)\/([^/]+)\/(?:m|[^/]+\/0\/[^/]+)\/(\d+)\.[cm]\.gz$/;

/** The catalog (§8.8), kept from the keys written: what a viewer may fetch, so it never probes (REV M-7). */
export class Catalog {
	private maps = new Map<string, Map<string, Surf>>();

	add(key: string): void {
		const a = AREA.exec(key);
		const tags = TAGS.exec(key);
		const day = DAY.exec(key);
		const first = FIRST.exec(key);
		if (a) {
			this.force(a[1], a[2], a[3]).areas[Number(a[4])].add(a[5]);
		}
		if (tags) {
			this.force(tags[1], tags[2], tags[3]).tags = true;
		}
		if (day) {
			this.surf(day[1], day[2]).days.add(day[3]);
		}
		if (first) {
			const s = this.surf(first[1], first[2]);
			s.first = Math.min(s.first, Number(first[3]));
		}
	}

	/**
	 * maps.json.gz: every map with files (plan ruling 8), its title, tile size and bounds from the cluster as it is
	 * now (or its id as the title, once no instance is left), each surface's days, edges and areas, and the icons of
	 * the default mod pack's export, when it has one (controller ruling R2).
	 */
	json(
		info: Record<string, MapInfo>, edges: Map<string, Quad[]>, updated: number, windowMs: number,
		assets?: Record<string, string>,
	): CatalogJson {
		const maps: CatalogJson["maps"] = {};
		for (const [map, surfs] of this.maps) {
			const surfaces: CatalogJson["maps"][string]["surfaces"] = {};
			for (const [surface, s] of surfs) {
				const forces: Record<string, { tags: boolean; areas: string[][] }> = {};
				for (const [force, f] of s.forces) {
					forces[force] = { tags: f.tags, areas: f.areas.map(set => [...set].sort()) };
				}
				surfaces[surface] = {
					first: Number.isFinite(s.first) ? s.first : updated,
					live: s.days.size > 0,
					days: [...s.days].sort(),
					edges: edges.get(`${map}|${surface}`) ?? [],
					forces,
				};
			}
			maps[map] = { ...(info[map] ?? { title: map, instances: {} }), surfaces };
		}
		const icons = assets?.spritesheet && assets.metadata
			? { png: `icons/${basename(assets.spritesheet)}`, json: `icons/${basename(assets.metadata)}` }
			: undefined;
		return { updated, window_ms: windowMs, live_ms: 5000, ...(icons ? { icons } : {}), maps };
	}

	private surf(map: string, surface: string): Surf {
		let surfs = this.maps.get(map);
		if (!surfs) {
			surfs = new Map();
			this.maps.set(map, surfs);
		}
		const game = unname(surface);
		let s = surfs.get(game);
		if (!s) {
			s = { first: Infinity, days: new Set(), forces: new Map() };
			surfs.set(game, s);
		}
		return s;
	}

	private force(map: string, surface: string, force: string): Force {
		const s = this.surf(map, surface);
		const game = unname(force);
		let f = s.forces.get(game);
		if (!f) {
			f = { tags: false, areas: Array.from({ length: LEVELS }, () => new Set<string>()) };
			s.forces.set(game, f);
		}
		return f;
	}
}
