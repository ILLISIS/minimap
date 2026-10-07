import * as lib from "@clusterio/lib";
import type { LiveMover, MoverGone, MoverSample } from "../contracts.js";
import { dayKey, keyframeKey, moveKey, unname, utcDay, type DayIndex } from "../shared/keys.js";
import type { Disk } from "./disk.js";
import type { Out } from "./index.js";

/** Mover samples taken into the store, and samples and gones the owner rule dropped (spec §14, K28). */
export const samplesTaken = new lib.Counter(
	"clusterio_minimap_samples_total",
	"Minimap mover samples taken into the store",
);
export const ownerDrops = new lib.Counter(
	"clusterio_minimap_owner_drops_total",
	"Minimap mover samples and gones dropped by the owner rule (K28)",
);

/** A window row (§8.7) with its absolute time until the close; [mover, t] alone is gone. */
type Row = [mover: number, t: number] | [mover: number, t: number, x: number, y: number, vx: number, vy: number];

type Surf = {
	map: string;
	surface: string;
	/** Every owned mover's last sample, parked ones included (§10.6). */
	live: Map<string, LiveMover>;
	/** The open window: each mover's row in `movers`, and the samples. */
	ids: Map<string, number>;
	movers: (string | number)[][];
	rows: Row[];
	/** Samples are filed no earlier: after the last close and the last window's samples (plan ruling 2). */
	floor: number;
	/** The day indexes this store may still change, and those changed since the last close. */
	days: Map<string, DayIndex>;
	touched: Set<string>;
	/** Changed since the last liveChanged(). */
	changed: boolean;
	/** Every owned sample of the last TRAIL ms, oldest first; a gone mover's are dropped. */
	trail: LiveMover[];
};

const round = (v: number, k: number) => Math.round(v * k) / k;

/**
 * Plan F ruling P2 (§22.2): the public page draws movers 16 s behind live, so its live file carries every sample of
 * the last 16 s, not only each mover's last: one between two PUTs, or in a PUT a later one replaced (§10.6), or in a
 * file a poll missed, still reaches it.
 */
export const TRAIL = 16_000;

export class Movers {
	/** K28: a journey's owner, the first instance to sample it; mm.adopt moves it, its owner's gone clears it. */
	readonly owner = new Map<string, number>();
	private where = new Map<string, Surf>();
	private surfs = new Map<string, Surf>();
	/** §6.7: what each resyncing instance has re-sent since its mm.surfaces (plan ruling 6). */
	private seen = new Map<number, Set<string>>();

	constructor(private disk: Disk) {}

	/** mm.move (§6.3): samples and gones from `instance`, kept only while it owns the journey (K28). */
	move(instance: number, map: string, surface: string, t: number, list: (MoverSample | MoverGone)[], out: Out): void {
		for (const m of list) {
			const own = this.owner.get(m.j);
			if (own !== undefined && own !== instance) {
				ownerDrops.inc();
			} else if ("gone" in m) {
				if (own !== undefined) {
					this.gone(m.j, t, out);
				}
			} else {
				this.sample(instance, map, surface, t, m, out);
			}
		}
	}

	/** mm.adopt (K28): the destination owns the journey from now on. Returns the owner before, for the log. */
	adopt(instance: number, j: string): number | undefined {
		const previous = this.owner.get(j);
		this.owner.set(j, instance);
		return previous;
	}

	begin(instance: number): void {
		this.seen.set(instance, new Set());
	}

	/** mm.resynced (K28): the movers the instance owns and didn't re-send since its mm.surfaces are gone at t. */
	resynced(instance: number, t: number, out: Out): void {
		const seen = this.seen.get(instance);
		if (!seen) {
			return;
		}
		this.seen.delete(instance);
		for (const [j, own] of this.owner) {
			if (own === instance && !seen.has(j)) {
				this.gone(j, t, out);
			}
		}
	}

	/** §7.3: a stopped instance's players are gone, as v1's were; its trains and vehicles stay parked. */
	stopped(instance: number, t: number, out: Out): void {
		for (const [j, own] of this.owner) {
			if (own === instance && j.startsWith("p:")) {
				this.gone(j, t, out);
			}
		}
	}

	/**
	 * The close at c (§8.7, K35): each map surface's window file named by its earliest sample, a keyframe per map
	 * surface with live movers when asked (the first close of a UTC hour, K12), and every day index that changed or
	 * whose day has ended, which is then final.
	 */
	async close(
		c: number, keyframe: boolean, failed: (key: string, err: Error) => void,
	): Promise<{ files: string[]; days: string[]; samples: number }> {
		const files: string[] = [];
		const days: string[] = [];
		let samples = 0;
		const today = utcDay(c);
		for (const s of this.surfs.values()) {
			try {
				if (s.rows.length > 0) {
					samples += await this.window(s, files);
				}
				if (keyframe && s.live.size > 0) {
					const key = keyframeKey(s.map, s.surface, c);
					await this.disk.put(key, JSON.stringify({ t: c, movers: [...s.live.values()] }));
					files.push(key);
					(await this.day(s, today)).keys.push(c);
				}
			} catch (err: any) {
				failed(`${s.map}|${s.surface}`, err);
			}
			s.floor = Math.max(s.floor, c + 1);
			for (const [day, index] of s.days) {
				if (!s.touched.has(day) && day >= today) {
					continue;
				}
				const key = dayKey(s.map, s.surface, day);
				try {
					await this.disk.put(key, JSON.stringify(index));
					days.push(key);
					s.touched.delete(day);
					if (day < today) {
						s.days.delete(day);
					}
				} catch (err: any) {
					failed(key, err);
				}
			}
		}
		return { files, days, samples };
	}

	/**
	 * At start: each map surface with a day index is marked changed, so the first live tick puts its live file, with
	 * no movers until they are re-sent, and the catalog's `live: true` never names a missing file (plan ruling 25).
	 */
	load(keys: string[]): void {
		for (const key of keys) {
			const m = /^([^/]+)\/([^/]+)\/m\/\d{4}-\d\d-\d\d\.json\.gz$/.exec(key);
			if (m) {
				this.surf(m[1], unname(m[2])).changed = true;
			}
		}
	}

	/**
	 * Changed map surfaces since the last call, each with every owned live mover's last sample (§10.6) and every sample
	 * of the last TRAIL ms (ruling P2).
	 */
	liveChanged(t: number): { map: string; surface: string; t: number; movers: LiveMover[] }[] {
		return [...this.surfs.values()].filter(s => s.changed).map(s => {
			s.changed = false;
			s.trail = s.trail.filter(m => m[9] >= t - TRAIL);
			return { map: s.map, surface: s.surface, t, movers: [...new Set([...s.trail, ...s.live.values()])] };
		});
	}

	live(map: string, surface: string): LiveMover[] {
		return [...this.surfs.get(`${map}|${surface}`)?.live.values() ?? []];
	}

	private sample(instance: number, map: string, surface: string, t: number, m: MoverSample, out: Out): void {
		this.owner.set(m.j, instance);
		this.seen.get(instance)?.add(m.j);
		samplesTaken.inc();
		const s = this.surf(map, surface);
		const before = this.where.get(m.j);
		const last = before?.live.get(m.j);
		const n = m.n ?? last?.[4] ?? 0;
		if (before && before !== s) {
			this.end(m.j, t, out); // Review Focus 5: it left that map surface
		}
		const at = Math.max(t, s.floor);
		// §22.2: a train's kinds and colour; a sample without them keeps its last sample's
		const lm: LiveMover = [
			m.j, m.k, m.f, m.name, n, m.x, m.y, m.vx, m.vy, at, m.o ?? last?.[10] ?? "", m.c ?? last?.[11] ?? "",
		];
		s.live.set(m.j, lm);
		// bounded with S3 off, where liveChanged isn't called; drop from the front, not a copy per sample
		while (s.trail.length > 0 && s.trail[0][9] < at - TRAIL) {
			s.trail.shift();
		}
		s.trail.push(lm);
		this.where.set(m.j, s);
		s.changed = true;
		s.rows.push([this.id(s, lm), at, m.x, m.y, m.vx, m.vy]);
		(out(map, surface).movers ??= []).push(lm);
	}

	private gone(j: string, t: number, out: Out): void {
		this.owner.delete(j);
		this.end(j, t, out);
	}

	/** The mover leaves its map surface's live set, with a gone row in that surface's window. */
	private end(j: string, t: number, out: Out): void {
		const s = this.where.get(j);
		const lm = s?.live.get(j);
		if (!s || !lm) {
			return;
		}
		s.live.delete(j);
		s.trail = s.trail.filter(x => x[0] !== j);
		this.where.delete(j);
		s.changed = true;
		s.rows.push([this.id(s, lm), Math.max(t, s.floor)]);
		(out(s.map, s.surface).gone ??= []).push(j);
	}

	/** The mover's row in this window's `movers`: [id, kind, force, name], and n, kinds and colour for a train. */
	private id(s: Surf, lm: LiveMover): number {
		let i = s.ids.get(lm[0]);
		if (i === undefined) {
			i = s.movers.length;
			s.ids.set(lm[0], i);
			s.movers.push(lm[1] === "t"
				? [lm[0], lm[1], lm[2], lm[3], lm[4], lm[10], lm[11]]
				: [lm[0], lm[1], lm[2], lm[3]]);
		}
		return i;
	}

	/** The window file, named by its earliest sample; returns the samples in it. */
	private async window(s: Surf, files: string[]): Promise<number> {
		const first = s.rows.reduce((m, r) => Math.min(m, r[1]), Infinity);
		const last = s.rows.reduce((m, r) => Math.max(m, r[1]), -Infinity);
		const key = moveKey(s.map, s.surface, first);
		const rows = s.rows.map(r => (r.length === 2
			? [r[0], r[1] - first]
			: [r[0], r[1] - first, round(r[2], 10), round(r[3], 10), round(r[4], 100), round(r[5], 100)]));
		await this.disk.put(key, JSON.stringify({ t: first, movers: s.movers, s: rows }));
		files.push(key);
		(await this.day(s, utcDay(first))).windows.push([first, last]);
		const samples = s.rows.filter(r => r.length > 2).length;
		s.floor = last + 1;
		s.ids.clear();
		s.movers = [];
		s.rows = [];
		return samples;
	}

	/** A day index, read from disk the first time, so a restarted store extends it (Review Focus 3). */
	private async day(s: Surf, day: string): Promise<DayIndex> {
		let index = s.days.get(day);
		if (!index) {
			index = await this.disk.json<DayIndex>(dayKey(s.map, s.surface, day)) ?? { windows: [], keys: [] };
			s.days.set(day, index);
		}
		s.touched.add(day);
		return index;
	}

	private surf(map: string, surface: string): Surf {
		const key = `${map}|${surface}`;
		let s = this.surfs.get(key);
		if (!s) {
			s = {
				map, surface, live: new Map(), ids: new Map(), movers: [], rows: [], floor: 0, days: new Map(),
				touched: new Set(), changed: false, trail: [],
			};
			this.surfs.set(key, s);
		}
		return s;
	}
}
