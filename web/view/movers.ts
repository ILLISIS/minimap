// Movers at time t (spec §11.4, §11.7, §22.2, K31): samples from keyframes, movement windows and live updates. A mover
// runs on from its last sample by its velocity for at most 60 s of data-clock age, blending into its next sample over
// the BLEND ms before it; a train is its carriages along its path. Times are the data's (wall-clock ms from the
// instances); Date.now() is never read. DOM-free.
import type { LiveMover } from "../../contracts.js";

/** K31: extrapolate, or blend across a gap, for at most this long. */
export const CAP = 60_000;
/**
 * Plan F ruling P1 (§22.2): a mover blends into its next sample over this long before it. Lua polls a mover every 30
 * ticks or more (K6), so the turn that made it send that sample lies in its last 500 ms; drawn 2 s behind, the
 * Clusterio page holds that sample by then (it arrives about a second after it was taken, §7.3).
 * ponytail: holds while the mover walk takes ≤ 30 ticks (core.WALK = 8 movers a tick: ≤ 240 moving movers an instance);
 * past that a turn can lie further back than BLEND and the drawing runs straight past it for a moment. Upgrade: blend
 * over the walk's length.
 */
export const BLEND = 500;
/** Tiles from one carriage's centre to the next: Factorio's joint and connection distances, 4 + 3 (§11.7, §22.2). */
const PITCH = 7;

/** A sample, or (gone) the mover's end at t. */
type Ev = {
	t: number; x: number; y: number; vx: number; vy: number; h: number; gone: boolean;
	n: number; kinds: string; colour: string;
};
type Track = {
	kind: "t" | "v" | "p"; force: string; name: string; evs: Ev[];
};

/**
 * One carriage (§22.2): its centre, its angle along the path in radians (toward the leading end), whether it is a
 * locomotive, and its kind letter (§22.6: upper case when it faces the leading end, lower when it faces back; an old
 * sample's are all upper case).
 */
export type Car = { x: number; y: number; a: number; loco: boolean; kind: string };

/** What a frame draws for one mover. */
export type Shown = {
	id: string;
	kind: "t" | "v" | "p";
	force: string;
	name: string;
	x: number;
	y: number;
	/** The heading, a unit vector. */
	hx: number;
	hy: number;
	/** Its drawn position still changes as t advances. */
	moving: boolean;
	/** A train's path, from its leading end back n × 7 tiles (§11.7); [] for vehicles and players. */
	path: [number, number][];
	/** A train's carriages along its path (§22.2); [] for vehicles and players. */
	cars: Car[];
	/** A train's leading locomotive's colour, "rrggbb"; "" when Lua sent none. */
	colour: string;
	/** A vehicle's kind (§22.5), "S" a spidertron, else "C"; a train's carriages' kinds (§22.2). */
	kinds: string;
};

/**
 * A movement window (§8.7): movers [id, kind, force, name], a train's with n, kinds and colour (§22.2); rows
 * [mover, dt, x, y, vx, vy], or [mover, dt].
 */
export type Window = { t: number; movers: (string | number)[][]; s: number[][] };
/** A keyframe file (Plan B's ruling 7): every live mover's last sample, as live.json's tuples. */
export type Keyframe = { t: number; movers: LiveMover[] };

/**
 * Each mover's samples and ends, in time order. `keep` caps the events a mover holds: the live view keeps 64, about
 * 32 s of a train sampled at every poll on a curve, which covers the public page's 16-s delay (§22.2).
 */
export class Tracks {
	private m = new Map<string, Track>();
	/** Each keyframe's time and the movers it lists. */
	private frames = new Map<number, Set<string>>();

	constructor(private keep = Infinity) {}

	get size(): number {
		return this.m.size;
	}

	clear(): void {
		this.m.clear();
		this.frames.clear();
	}

	/**
	 * A keyframe: every mover live at its time, with its last sample. A mover it doesn't list, whose last event before
	 * t is older than the keyframe, was gone by then (its gone row may sit in a window not loaded).
	 */
	keyframe(k: Keyframe): void {
		this.frames.set(k.t, new Set(k.movers.map(m => m[0])));
		this.live(k.t, k.movers);
	}

	window(w: Window): void {
		for (const row of w.s) {
			const [i, dt, x, y, vx, vy, h = 0] = row;
			// A window written before §22.2 has no kinds or colour.
			const [id, kind, force, name, n = 0, kinds = "", colour = ""] = w.movers[i] as
				[string, Track["kind"], string, string, number?, string?, string?];
			const tr = this.track(id, kind, force, name);
			this.add(tr, row.length === 2
				? { t: w.t + dt, x: 0, y: 0, vx: 0, vy: 0, h: 0, gone: true }
				: { t: w.t + dt, x, y, vx, vy, h, gone: false }, n, kinds, colour);
		}
	}

	/**
	 * Samples as live.json and MinimapLiveEvent carry them, and the ids gone at t. A gone is an event at t like any
	 * other, so a view drawn behind live (§22.2) shows the mover until then.
	 */
	live(t: number, movers: LiveMover[] = [], gone: string[] = []): void {
		// A keyframe written before §22.2 has no kinds or colour.
		for (const [id, kind, force, name, n, x, y, vx, vy, ts, kinds = "", colour = "", h = 0] of movers) {
			this.add(this.track(id, kind, force, name), { t: ts, x, y, vx, vy, h, gone: false }, n, kinds, colour);
		}
		for (const id of gone) {
			const tr = this.m.get(id);
			if (tr) {
				this.add(tr, { t, x: 0, y: 0, vx: 0, vy: 0, h: 0, gone: true });
			}
		}
	}

	/** Every mover shown at t. */
	at(t: number): Shown[] {
		const k = Math.max(...[...this.frames.keys()].filter(kt => kt <= t));
		const listed = this.frames.get(k);
		const out: Shown[] = [];
		for (const [id, tr] of this.m) {
			const end = tr.evs[tr.evs.length - 1];
			// The live view forgets a mover once its gone is drawn: a page left open doesn't keep every mover it saw.
			if (this.keep < Infinity && end.gone && end.t <= t) {
				this.m.delete(id);
				continue;
			}
			let i = tr.evs.length - 1;
			while (i >= 0 && tr.evs[i].t > t) {
				i -= 1;
			}
			if (i >= 0 && !tr.evs[i].gone && (!listed || tr.evs[i].t >= k || listed.has(id))) {
				out.push(this.place(id, tr, i, t));
			}
		}
		return out;
	}

	/**
	 * Mover tr at t, from its last sample i at or before t (plan F ruling P1): on by its velocity for at most CAP of
	 * data time (K31), then held; over the BLEND ms before its next sample, the gap to that sample is closed, so the
	 * drawing follows a turn and never snaps. Never towards a gone, nor across a gap over CAP.
	 */
	private place(id: string, tr: Track, i: number, t: number): Shown {
		const e = tr.evs[i];
		const next = tr.evs[i + 1];
		const run = (u: number): [number, number] => {
			const s = Math.min(u - e.t, CAP) / 1000;
			return [e.x + (e.vx * s), e.y + (e.vy * s)];
		};
		let [x, y] = run(t);
		let moving = (e.vx !== 0 || e.vy !== 0) && t - e.t < CAP;
		if (next && !next.gone && next.t - e.t <= CAP) {
			const [px, py] = run(next.t);
			const f = Math.max(0, 1 - ((next.t - t) / Math.min(BLEND, next.t - e.t)));
			x += f * (next.x - px);
			y += f * (next.y - py);
			// A parked mover with a moving sample ahead moves too: frames go on until it does (ruling P15).
			moving ||= next.x !== px || next.y !== py;
		}
		// A gone ahead is an event to draw: frames go on until it is (ruling P10; a parked mover has no other reason).
		moving ||= next !== undefined && next.gone;
		const [hx, hy] = heading(tr.evs, i, tr.kind);
		const path = tr.kind === "t" ? line(tr.evs, i, x, y, hx, hy, e.n * PITCH) : [];
		return {
			id, kind: tr.kind, force: tr.force, name: tr.name, x, y, hx, hy, moving, path,
			cars: carriages(path, tr.kind === "t" ? e.n : 0, e.kinds), colour: e.colour, kinds: e.kinds,
		};
	}

	private track(id: string, kind: Track["kind"], force: string, name: string): Track {
		let tr = this.m.get(id);
		if (!tr) {
			tr = { kind, force, name, evs: [] };
			this.m.set(id, tr);
		}
		// The latest sample names the mover: a player can change force. A train's length, carriages and colour ride on
		// each event (add), so the drawn time shows the ones it had then.
		Object.assign(tr, { kind, force, name });
		return tr;
	}

	/** Insert in time order (windows list rows in arrival order); an event at an existing time replaces it. */
	private add(tr: Track, base: Omit<Ev, "n" | "kinds" | "colour">, n = 0, kinds = "", colour = ""): void {
		// A window or keyframe written before §22.2 has none: the mover's latest event's stand, not the one before
		// it in time (only history spanning the deploy shows it).
		const last = tr.evs[tr.evs.length - 1];
		const ev: Ev = {
			...base, n: n || last?.n || 0, kinds: kinds || last?.kinds || "", colour: colour || last?.colour || "",
		};
		let i = tr.evs.length;
		while (i > 0 && tr.evs[i - 1].t > ev.t) {
			i -= 1;
		}
		if (i > 0 && tr.evs[i - 1].t === ev.t) {
			tr.evs[i - 1] = ev;
		} else {
			tr.evs.splice(i, 0, ev);
		}
		if (tr.evs.length > this.keep) {
			tr.evs.splice(0, tr.evs.length - this.keep);
		}
	}
}

/**
 * The direction of travel: the velocity, else (a train at rest) the heading Lua sent, else the step from the sample
 * before, else east.
 */
function heading(evs: Ev[], i: number, kind: Track["kind"]): [number, number] {
	const e = evs[i];
	const prev = evs[i - 1];
	if (kind !== "p" && e.vx === 0 && e.vy === 0) {
		const a = e.h * 2 * Math.PI;
		return [Math.sin(a), -Math.cos(a)];
	}
	const [dx, dy] = e.vx !== 0 || e.vy !== 0 || !prev || prev.gone ? [e.vx, e.vy] : [e.x - prev.x, e.y - prev.y];
	const len = Math.hypot(dx, dy);
	return len === 0 ? [1, 0] : [dx / len, dy / len];
}

/**
 * A train's line from (x, y) back through its earlier samples for `length` tiles; past them, on in the direction of
 * the last step, or against its heading with no step behind it.
 */
function line(evs: Ev[], i: number, x: number, y: number, hx: number, hy: number, length: number): [number, number][] {
	const out: [number, number][] = [[x, y]];
	let left = length;
	for (let j = i; j >= 0 && !evs[j].gone; j--) {
		const [px, py] = out[out.length - 1];
		const d = Math.hypot(evs[j].x - px, evs[j].y - py);
		if (d > 0 && d >= left) {
			out.push([px + ((evs[j].x - px) * left / d), py + ((evs[j].y - py) * left / d)]);
			return out;
		}
		if (d > 0) {
			out.push([evs[j].x, evs[j].y]);
			left -= d;
		}
	}
	const [px, py] = out[out.length - 1];
	const [qx, qy] = out.length > 1 ? out[out.length - 2] : [px + hx, py + hy];
	const d = Math.hypot(px - qx, py - qy);
	out.push([px + ((px - qx) * left / d), py + ((py - qy) * left / d)]);
	return out;
}

/**
 * §22.2: n carriages along `path`, carriage i centred i × 7 tiles back from its first point (the leading carriage's
 * centre, which Lua samples, §6.3; plan F ruling P9) and turned along the path there; kinds[i] "L" or "l"
 * is a locomotive.
 * A path shorter than the train places the carriages it has room for.
 */
export function carriages(path: [number, number][], n: number, kinds: string): Car[] {
	const cars: Car[] = [];
	let i = 0;
	let walked = 0;
	for (let j = 1; j < path.length && i < n; j++) {
		const [ax, ay] = path[j - 1];
		const [bx, by] = path[j];
		const len = Math.hypot(bx - ax, by - ay);
		while (i < n && i * PITCH <= walked + len) {
			const f = len === 0 ? 0 : ((i * PITCH) - walked) / len;
			const [x, y] = [ax + (f * (bx - ax)), ay + (f * (by - ay))];
			const kind = kinds[i] ?? "C";
			cars.push({ x, y, a: Math.atan2(ay - by, ax - bx), loco: kind === "L" || kind === "l", kind });
			i += 1;
		}
		walked += len;
	}
	return cars;
}

/**
 * The data clock (§11.4): the newest server time seen (a live payload's t, the catalog's `updated`, a response's
 * Date header), plus the browser's elapsed time since it was seen. It never goes back, and never reads Date.now().
 */
export class Clock {
	private ref = -Infinity;
	private seen = 0;

	constructor(readonly perf: () => number = () => performance.now()) {}

	see(t: number): void {
		if (t > this.now()) {
			this.ref = t;
			this.seen = this.perf();
		}
	}

	now(): number {
		return this.ref + (this.perf() - this.seen);
	}
}
