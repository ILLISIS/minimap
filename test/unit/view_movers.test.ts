import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveMover } from "../../contracts.js";
import { BLEND, CAP, Clock, Tracks, carriages } from "../../web/view/movers.js";

const T = 1_759_600_000_000;
const car = (x: number, vx: number, ts: number, id = "1.5.v7"): LiveMover => [
	id, "v", "player", "car", 0, x, 0, vx, 0, ts, "", "",
];
const where = (tracks: Tracks, t: number) => tracks.at(t).map(m => [m.id, Math.round(m.x * 100) / 100, m.moving]);

test("between two samples a mover runs on by its velocity, and blends into the next over its last 500 ms", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 10, T)]);
	tracks.live(T + 2000, [car(30, 10, T + 2000)]);
	assert.deepEqual(where(tracks, T + 500), [["1.5.v7", 5, true]], "by its velocity, the next sample still ahead");
	assert.deepEqual(where(tracks, T + 2000 - (BLEND / 2)), [["1.5.v7", 22.5, true]], "halfway: 17.5 + half of 10");
	assert.deepEqual(where(tracks, T + 2000), [["1.5.v7", 30, true]]);
	assert.deepEqual(tracks.at(T - 1), [], "nothing before its first sample");
});

test("past its last sample a mover runs on by its velocity for at most 60 s of data time, then holds (K31)", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(5, 2, T)]);
	assert.deepEqual(where(tracks, T + 30_000), [["1.5.v7", 65, true]]);
	assert.deepEqual(where(tracks, T + CAP), [["1.5.v7", 125, false]]);
	assert.deepEqual(where(tracks, T + 3_600_000), [["1.5.v7", 125, false]], "held an hour later");
});

test("movers at t read only the data's time: Date.now() is never called", () => {
	const real = Date.now;
	Date.now = () => {
		throw new Error("Date.now() read");
	};
	try {
		let perf = 0;
		const clock = new Clock(() => perf);
		const tracks = new Tracks();
		clock.see(T);
		tracks.live(T, [car(0, 1, T)]);
		perf = 90_000;
		assert.deepEqual(where(tracks, clock.now()), [["1.5.v7", 60, false]]);
	} finally {
		Date.now = real;
	}
});

test("the data clock is the newest time seen plus the elapsed time since; an older time doesn't move it back", () => {
	let perf = 1000;
	const clock = new Clock(() => perf);
	assert.equal(clock.now(), -Infinity, "nothing seen yet");
	clock.see(T);
	perf = 3500;
	assert.equal(clock.now(), T + 2500);
	clock.see(T + 1000);
	assert.equal(clock.now(), T + 2500, "older than now: ignored");
	clock.see(T + 5000);
	perf = 4000;
	assert.equal(clock.now(), T + 5500);
});

test("a parked mover holds until its next sample, and a gap over 60 s is never interpolated across", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 0, T)]);
	tracks.live(T + 600_000, [car(500, 10, T + 600_000)]);
	assert.deepEqual(where(tracks, T + 300_000), [["1.5.v7", 0, false]], "parked: no creeping towards the next sample");
	const gap = new Tracks();
	gap.live(T, [car(0, 1, T)]);
	gap.live(T + 600_000, [car(900, 1, T + 600_000)]);
	assert.deepEqual(where(gap, T + 300_000), [["1.5.v7", 60, false]], "an instance offline: 60 s on, then held");
});

test("a gone mover is hidden from its end on; a keyframe hides movers it doesn't list from its time on", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 0, T), car(9, 0, T, "p:bob")]);
	tracks.live(T + 1000, [], ["p:bob"]);
	assert.deepEqual(tracks.at(T + 999).map(m => m.id), ["1.5.v7", "p:bob"]);
	assert.deepEqual(tracks.at(T + 1000).map(m => m.id), ["1.5.v7"]);
	const past = new Tracks();
	past.live(T, [car(0, 0, T), car(9, 0, T, "p:bob")]);
	past.keyframe({ t: T + 3_600_000, movers: [car(0, 0, T)] });
	assert.deepEqual(past.at(T + 3_599_999).map(m => m.id), ["1.5.v7", "p:bob"]);
	assert.deepEqual(past.at(T + 3_600_000).map(m => m.id), ["1.5.v7"], "bob's gone row is in a window not loaded");
});

test("a window's rows are put in time order, and [mover, dt] alone is a gone (§8.7)", () => {
	const tracks = new Tracks();
	tracks.window({
		t: T,
		movers: [["2.1.1", "t", "player", "locomotive", 2, "LC", "00ff00"], ["p:bob", "p", "player", "bob"]],
		s: [[0, 2000, 20, 0, 10, 0], [1, 0, 5, 5, 0, 0], [0, 0, 0, 0, 10, 0], [1, 1500]],
	});
	assert.deepEqual(where(tracks, T + 1000), [["2.1.1", 10, true], ["p:bob", 5, false]]);
	assert.deepEqual(where(tracks, T + 1500), [["2.1.1", 15, true]]);
	const [train] = tracks.at(T + 1500);
	assert.deepEqual([train.colour, train.cars.map(c => c.loco)], ["00ff00", [true, false]], "its kinds and colour");
});

test("a train is a line n × 7 tiles back along its samples, then on in the direction of the last step (§11.7)", () => {
	const tracks = new Tracks();
	const train = (x: number, y: number, vx: number, vy: number, ts: number): LiveMover => [
		"2.1.1", "t", "player", "locomotive", 3, x, y, vx, vy, ts, "LCL", "0000ff",
	];
	tracks.live(T, [train(0, 0, 10, 0, T)]);
	tracks.live(T + 1000, [train(10, 0, 0, 10, T + 1000)]);
	tracks.live(T + 1500, [train(10, 5, 0, 10, T + 1500)]);
	const [m] = tracks.at(T + 1500);
	assert.deepEqual([m.hx, m.hy], [0, 1], "heading down");
	assert.deepEqual(m.path, [[10, 5], [10, 0], [0, 0], [-6, 0]], "21 tiles: 5 + 10 along samples, 6 on");
	assert.deepEqual(m.cars.map(c => [c.x, c.y, c.loco]), [[10, 5, true], [8, 0, false], [1, 0, true]],
		"its carriages every 7 tiles along that line (§22.2)");
	assert.equal(m.colour, "0000ff");
	tracks.live(T + 1500, [["2.1.9", "t", "player", "locomotive", 0, 1, 1, 0, 0, T + 1500, "", ""]]);
	const odd = tracks.at(T + 1500).find(s => s.id === "2.1.9")!;
	assert.ok(odd.path.flat().every(Number.isFinite), "no carriages: no NaN");
	assert.deepEqual(odd.cars, []);
});

test("carriages (§22.2): centred every 7 tiles back from the leading end, each turned along the path there", () => {
	const round = (v: number) => Math.round(v * 1000) / 1000;
	const cars = carriages([[0, 0], [-10, 0], [-10, 11]], 3, "LC");
	assert.deepEqual(cars.map(c => [round(c.x), round(c.y), round(c.a), c.loco]), [
		[0, 0, 0, true],
		[-7, 0, 0, false],
		[-10, 4, round(-Math.PI / 2), false],
	], "the third past the bend, turned with it; a kind past the string's end is a wagon");
	assert.equal(carriages([[0, 0], [-10, 0]], 3, "LLL").length, 2, "a path shorter than the train: what fits");
	assert.deepEqual(carriages([[0, 0], [-7, 0]], 0, ""), [], "no carriages");
});

test("the live view keeps 64 events a mover", () => {
	const tracks = new Tracks(64);
	for (let i = 0; i < 100; i++) {
		tracks.live(T + i, [car(i, 1, T + i)]);
	}
	assert.deepEqual(where(tracks, T + 99), [["1.5.v7", 99, true]]);
	assert.deepEqual(tracks.at(T + 30), [], "older events were dropped");
});

test("the live view forgets a gone mover once its gone is drawn, not when it arrives (§22.2)", () => {
	const tracks = new Tracks(64);
	tracks.live(T, [car(0, 1, T)]);
	tracks.live(T + 2000, [], ["1.5.v7"]);
	assert.deepEqual(where(tracks, T + 1000), [["1.5.v7", 1, true]], "drawn 1 s on: the gone is still ahead");
	assert.equal(tracks.size, 1);
	assert.deepEqual(tracks.at(T + 2000), []);
	assert.equal(tracks.size, 0, "forgotten once drawn");
});

test("a parked mover holds until its next sample's last 500 ms, and counts as moving so frames reach them", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 0, T)]);
	tracks.live(T + 30_000, [car(500, 10, T + 30_000)]);
	assert.deepEqual(where(tracks, T + 15_000), [["1.5.v7", 0, true]]);
	assert.deepEqual(where(tracks, T + 30_000 - (BLEND / 2)), [["1.5.v7", 250, true]]);
});

test("a moving mover is never interpolated towards its gone row: it runs on by its velocity until then", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 10, T)]);
	tracks.live(T + 2000, [], ["1.5.v7"]);
	assert.deepEqual(where(tracks, T + 1000), [["1.5.v7", 10, true]]);
	assert.deepEqual(tracks.at(T + 2000), []);
});

/** The distance from (x, y) to the polyline `pts`. */
function off(pts: [number, number][], x: number, y: number): number {
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const [ax, ay] = pts[i - 1];
		const [bx, by] = pts[i];
		const len2 = ((bx - ax) ** 2) + ((by - ay) ** 2);
		const u = Math.max(0, Math.min(1, (((x - ax) * (bx - ax)) + ((y - ay) * (by - ay))) / len2));
		best = Math.min(best, Math.hypot(x - ax - (u * (bx - ax)), y - ay - (u * (by - ay))));
	}
	return best;
}

test("a mover turning a corner, drawn 2 s behind live, stays within ε of its true path and never snaps (§22.2)", () => {
	// East at 6 tiles a second from (0, 0); at 10.2 s it turns south.
	const path: [number, number][] = [[0, 0], [61.2, 0], [61.2, 100]];
	const truth = (s: number): [number, number] => (s <= 10.2 ? [6 * s, 0] : [61.2, 6 * (s - 10.2)]);
	// Lua's dead reckoning (core.poll, ε = 1): a poll every 30 ticks; the first records, the next sends; then a sample
	// whenever the mover is more than ε off its last sample's line on either axis, or 600 ticks on (§6.3).
	const samples: LiveMover[] = [];
	let last: { x: number; y: number; vx: number; vy: number; s: number } | undefined;
	let prev: [number, number, number] | undefined;
	for (let k = 0; k <= 40; k++) {
		const s = k / 2;
		const [x, y] = truth(s);
		if (prev) {
			const [vx, vy] = [(x - prev[0]) / (s - prev[2]), (y - prev[1]) / (s - prev[2])];
			if (!last || s - last.s >= 10 || Math.abs(x - last.x - (last.vx * (s - last.s))) > 1
				|| Math.abs(y - last.y - (last.vy * (s - last.s))) > 1) {
				last = { x, y, vx, vy, s };
				samples.push(["1.5.v7", "v", "player", "car", 0, x, y, vx, vy, T + (s * 1000), "", ""]);
			}
		}
		prev = [x, y, s];
	}
	assert.equal(samples.length, 3, "a sample on the straight, one at the turn, one after it");
	/** Frames every 50 ms of browser time, each sample arriving a second after it was taken (§7.3's batch). */
	const run = (delay: number) => {
		const tracks = new Tracks(64);
		let [worst, step, next] = [0, 0, 0];
		let was: { x: number; y: number } | undefined;
		for (let r = 0; r <= 22_000; r += 50) {
			const arrived: LiveMover[] = [];
			while (next < samples.length && samples[next][9] + 1000 <= T + r) {
				arrived.push(samples[next]);
				next += 1;
			}
			tracks.live(T + r, arrived);
			const [m] = tracks.at(T + r - delay);
			if (m) {
				worst = Math.max(worst, off(path, m.x, m.y));
				step = Math.max(step, was ? Math.hypot(m.x - was.x, m.y - was.y) : 0);
			}
			was = m;
		}
		return { worst, step };
	};
	const behind = run(2000);
	assert.ok(behind.worst <= 1, `drawn 2 s behind: ${behind.worst} tiles off the true path, over ε`);
	assert.ok(behind.step <= 0.5, `drawn 2 s behind: a ${behind.step}-tile jump between frames (a snap)`);
	assert.ok(run(0).worst > 5, "drawn at the live clock it overshoots the corner: the case is a real one");
});
