// Movers at time t (spec §11.4, §11.7, K31): samples from keyframes, movement windows and live updates;
// interpolation between a moving mover's samples, extrapolation by velocity for at most 60 s of data-clock age,
// then hold. Times are the data's (wall-clock ms from the instances); Date.now() is never read. DOM-free.
import type { LiveMover } from "../../contracts.js";

/** K31: extrapolate, or interpolate across a gap, for at most this long. */
export const CAP = 60_000;
/** Tiles per carriage, inferred (§11.7). */
const PITCH = 7;

/** A sample, or (gone) the mover's end at t. */
type Ev = { t: number; x: number; y: number; vx: number; vy: number; gone: boolean };
type Track = { kind: "t" | "v" | "p"; force: string; name: string; n: number; evs: Ev[] };

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
	/** A train's line, from its leading end back n × 7 tiles (§11.7); [] for vehicles and players. */
	path: [number, number][];
};

/** A movement window (§8.7): movers [id, kind, force, name, n?]; rows [mover, dt, x, y, vx, vy], or [mover, dt]. */
export type Window = { t: number; movers: (string | number)[][]; s: number[][] };
/** A keyframe file (Plan B's ruling 7): every live mover's last sample, as live.json's tuples. */
export type Keyframe = { t: number; movers: LiveMover[] };

/** Each mover's samples and ends, in time order. `keep` caps the events a mover holds (the live view keeps 16). */
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
			const [i, dt, x, y, vx, vy] = row;
			const [id, kind, force, name, n] = w.movers[i] as [string, Track["kind"], string, string, number?];
			const tr = this.track(id, kind, force, name, n ?? 0);
			this.add(tr, row.length === 2
				? { t: w.t + dt, x: 0, y: 0, vx: 0, vy: 0, gone: true }
				: { t: w.t + dt, x, y, vx, vy, gone: false });
		}
	}

	/**
	 * Samples as live.json and MinimapLiveEvent carry them, and the ids gone at t. The live view (a capped `keep`)
	 * forgets a gone mover, so a page left open doesn't collect every mover it ever saw.
	 */
	live(t: number, movers: LiveMover[] = [], gone: string[] = []): void {
		for (const [id, kind, force, name, n, x, y, vx, vy, ts] of movers) {
			this.add(this.track(id, kind, force, name, n), { t: ts, x, y, vx, vy, gone: false });
		}
		for (const id of gone) {
			const tr = this.m.get(id);
			if (tr && this.keep < Infinity) {
				this.m.delete(id);
			} else if (tr) {
				this.add(tr, { t, x: 0, y: 0, vx: 0, vy: 0, gone: true });
			}
		}
	}

	/** Every mover shown at t. */
	at(t: number): Shown[] {
		const k = Math.max(...[...this.frames.keys()].filter(kt => kt <= t));
		const listed = this.frames.get(k);
		const out: Shown[] = [];
		for (const [id, tr] of this.m) {
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

	private place(id: string, tr: Track, i: number, t: number): Shown {
		const e = tr.evs[i];
		const next = tr.evs[i + 1];
		const still = e.vx === 0 && e.vy === 0;
		let x: number;
		let y: number;
		let moving: boolean;
		if (next && !next.gone && !still && next.t - e.t <= CAP) {
			const f = (t - e.t) / (next.t - e.t);
			x = e.x + (f * (next.x - e.x));
			y = e.y + (f * (next.y - e.y));
			moving = next.x !== e.x || next.y !== e.y;
		} else {
			// K31: by velocity for at most CAP of data-clock age, then hold.
			const dt = Math.min(t - e.t, CAP) / 1000;
			x = e.x + (e.vx * dt);
			y = e.y + (e.vy * dt);
			moving = !still && t - e.t < CAP;
		}
		const [hx, hy] = heading(tr.evs, i);
		const path = tr.kind === "t" ? line(tr.evs, i, x, y, hx, hy, tr.n * PITCH) : [];
		return { id, kind: tr.kind, force: tr.force, name: tr.name, x, y, hx, hy, moving, path };
	}

	private track(id: string, kind: Track["kind"], force: string, name: string, n: number): Track {
		let tr = this.m.get(id);
		if (!tr) {
			tr = { kind, force, name, n, evs: [] };
			this.m.set(id, tr);
		}
		// The latest sample names the mover: a player can change force, a train its length.
		Object.assign(tr, { kind, force, name, n: n || tr.n });
		return tr;
	}

	/** Insert in time order (windows list rows in arrival order); an event at an existing time replaces it. */
	private add(tr: Track, ev: Ev): void {
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

/** The direction of travel: the velocity, else the step from the sample before, else east. */
function heading(evs: Ev[], i: number): [number, number] {
	const e = evs[i];
	const prev = evs[i - 1];
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
