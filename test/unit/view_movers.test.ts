import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveMover } from "../../contracts.js";
import { CAP, Clock, Tracks } from "../../web/view/movers.js";

const T = 1_759_600_000_000;
const car = (x: number, vx: number, ts: number, id = "1.5.v7"): LiveMover => [
	id, "v", "player", "car", 0, x, 0, vx, 0, ts,
];
const where = (tracks: Tracks, t: number) => tracks.at(t).map(m => [m.id, Math.round(m.x * 100) / 100, m.moving]);

test("between two samples of a moving mover, its position is interpolated", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 10, T)]);
	tracks.live(T + 2000, [car(30, 10, T + 2000)]);
	assert.deepEqual(where(tracks, T + 500), [["1.5.v7", 7.5, true]]);
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
		movers: [["2.1.1", "t", "player", "locomotive", 2], ["p:bob", "p", "player", "bob"]],
		s: [[0, 2000, 20, 0, 10, 0], [1, 0, 5, 5, 0, 0], [0, 0, 0, 0, 10, 0], [1, 1500]],
	});
	assert.deepEqual(where(tracks, T + 1000), [["2.1.1", 10, true], ["p:bob", 5, false]]);
	assert.deepEqual(where(tracks, T + 1500), [["2.1.1", 15, true]]);
});

test("a train is a line n × 7 tiles back along its samples, then on in the direction of the last step (§11.7)", () => {
	const tracks = new Tracks();
	const train = (x: number, y: number, vx: number, vy: number, ts: number): LiveMover => [
		"2.1.1", "t", "player", "locomotive", 3, x, y, vx, vy, ts,
	];
	tracks.live(T, [train(0, 0, 10, 0, T)]);
	tracks.live(T + 1000, [train(10, 0, 0, 10, T + 1000)]);
	tracks.live(T + 1500, [train(10, 5, 0, 10, T + 1500)]);
	const [m] = tracks.at(T + 1500);
	assert.deepEqual([m.hx, m.hy], [0, 1], "heading down");
	assert.deepEqual(m.path, [[10, 5], [10, 0], [0, 0], [-6, 0]], "21 tiles: 5 + 10 along samples, 6 on");
	tracks.live(T + 1500, [["2.1.9", "t", "player", "locomotive", 0, 1, 1, 0, 0, T + 1500]]);
	const odd = tracks.at(T + 1500).find(s => s.id === "2.1.9")!;
	assert.ok(odd.path.flat().every(Number.isFinite), "no carriages: no NaN");
});

test("the live view keeps 16 events a mover and forgets a gone mover", () => {
	const tracks = new Tracks(16);
	for (let i = 0; i < 40; i++) {
		tracks.live(T + i, [car(i, 1, T + i)]);
	}
	assert.deepEqual(where(tracks, T + 39), [["1.5.v7", 39, true]]);
	assert.deepEqual(tracks.at(T + 10), [], "older events were dropped");
	tracks.live(T + 50, [], ["1.5.v7"]);
	assert.equal(tracks.size, 0);
});

test("a parked mover holds until its next sample even when that is under 60 s away (Review Focus 3)", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 0, T)]);
	tracks.live(T + 30_000, [car(500, 10, T + 30_000)]);
	assert.deepEqual(where(tracks, T + 15_000), [["1.5.v7", 0, false]]);
});

test("a moving mover is never interpolated towards its gone row: it runs on by its velocity until then", () => {
	const tracks = new Tracks();
	tracks.live(T, [car(0, 10, T)]);
	tracks.live(T + 2000, [], ["1.5.v7"]);
	assert.deepEqual(where(tracks, T + 1000), [["1.5.v7", 10, true]]);
	assert.deepEqual(tracks.at(T + 2000), []);
});
