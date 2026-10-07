import assert from "node:assert/strict";
import { test } from "node:test";
import { train, type Pen } from "../../web/view/train.js";
import type { Car, Shown } from "../../web/view/movers.js";
import type { Viewer } from "../../web/view/viewer.js";

type Call = [string, ...unknown[]];

/** A 2D context that records each call and the style/width in force at it. */
function fake() {
	const calls: Call[] = [];
	const ctx = {
		fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "",
	} as Record<string, unknown>;
	const names = [
		"save", "restore", "translate", "rotate", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke",
	];
	for (const name of names) {
		ctx[name] = (...a: unknown[]) => {
			calls.push([name, ...a, ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth]);
		};
	}
	return { ctx: ctx as unknown as Pen, calls };
}

const view = { view: { x: 0, y: 0, s: 1 / 16 }, width: 1000, height: 1000 } as Viewer;
const car = (x: number, a = 0): Car => ({ x, y: 0, a, loco: false });
const shown = (cars: Car[], colour = "00ff00"): Shown => ({ cars, colour } as Shown);
const strokes = (calls: Call[]) => calls.filter(c => c[0] === "stroke");
const K = 16;

/** Each carriage's drawing between its save and restore: where it is turned to, its path and its outline's width. */
function boxes(calls: Call[]) {
	const out: { at: [number, number]; a: number; pts: [number, number][]; outline: number }[] = [];
	let cur: (typeof out)[number] | undefined;
	for (const c of calls) {
		if (c[0] === "save") {
			cur = { at: [0, 0], a: 0, pts: [], outline: 0 };
			out.push(cur);
		} else if (cur && c[0] === "translate") {
			cur.at = [c[1] as number, c[2] as number];
		} else if (cur && c[0] === "rotate") {
			cur.a = c[1] as number;
		} else if (cur && (c[0] === "moveTo" || c[0] === "lineTo")) {
			cur.pts.push([c[1] as number, c[2] as number]);
		} else if (cur && c[0] === "stroke") {
			cur.outline = c[3] as number;
		}
	}
	return out;
}
const extent = (pts: [number, number][], axis: 0 | 1) => {
	const v = pts.map(p => p[axis]);
	return Math.max(...v) - Math.min(...v);
};

test("one carriage: an outline in the train's colour 0.45 tile thick, a #f9ce3e fill", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0)]));
	const s = strokes(calls)[0];
	assert.equal(s[2], "#00ff00");
	assert.equal(s[3], 0.45 * 16);
	assert.ok(calls.some(c => c[0] === "fill" && c[1] === "#f9ce3e"));
});


test("every carriage but the first is a box 4.9 x 2.5 tiles outer", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0), car(-7)]));
	const b = boxes(calls)[1];
	assert.equal(b.pts.length, 4);
	const o = 0.45 * K;
	assert.ok(Math.abs(extent(b.pts, 0) + o - (4.9 * K)) < 1e-9);
	assert.ok(Math.abs(extent(b.pts, 1) + o - (2.5 * K)) < 1e-9);
});

test("the leading carriage: back corners, sides 2.5 tiles from the back, tip at the front", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0, 0.5), car(-7, 0.5)]));
	const b = boxes(calls)[0];
	assert.equal(b.a, 0.5);
	assert.equal(b.pts.length, 5);
	const o = 0.45 * K;
	const back = -(4.9 * K / 2) + (o / 2);
	const [c1, s1, tip, s2, c2] = b.pts;
	assert.ok(Math.abs(c1[0] - back) < 1e-9 && Math.abs(c2[0] - back) < 1e-9, "back corners");
	assert.ok(Math.abs(s1[0] - (-(4.9 * K / 2) + (2.5 * K))) < 1e-9, "sides end 2.5 tiles from the back");
	assert.equal(s1[0], s2[0]);
	assert.equal(s1[1], c1[1]);
	assert.equal(s2[1], c2[1]);
	assert.equal(tip[1], 0);
	assert.ok(tip[0] > s1[0] && tip[0] <= (4.9 * K / 2), "the tip is at the front, not past it");
});

test("bars run from one box's back edge to the next box's front edge, along the path", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0), car(-7)]));
	const bar = calls.findIndex(c => c[0] === "stroke" && c[3] === 0.75 * K);
	const [m, l] = [calls[bar - 2], calls[bar - 1]];
	assert.equal(m[0], "moveTo");
	assert.ok(Math.abs((m[1] as number) - (500 - (2.45 * K))) < 1e-9);
	assert.ok(Math.abs((l[1] as number) - (500 - (7 * K) + (2.45 * K))) < 1e-9);
	assert.equal(m[2], 500);
});

test("three carriages draw two bars, 0.75 tile thick in the train's colour", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0), car(-7), car(-14)]));
	const bars = strokes(calls).filter(c => c[3] === 0.75 * K);
	assert.equal(bars.length, 2);
	assert.equal(bars[0][2], "#00ff00");
});

test("far out: each carriage's outline is 1 px and its box at least 3 x 2 px", () => {
	const { ctx, calls } = fake();
	train(ctx, { ...view, view: { x: 0, y: 0, s: 64 } } as Viewer, shown([car(0), car(7)]));
	for (const b of boxes(calls)) {
		assert.equal(b.outline, 1);
	}
	assert.ok(extent(boxes(calls)[1].pts, 0) + 1 >= 3 - 1e-9);
	assert.ok(extent(boxes(calls)[1].pts, 1) + 1 >= 2 - 1e-9);
});

test("on a curve each carriage is turned along its own angle and put at its own centre", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0, 0.3), car(-7, 0.2), car(-14, 0.1)]));
	assert.deepEqual(boxes(calls).map(b => b.a), [0.3, 0.2, 0.1]);
	assert.deepEqual(boxes(calls).map(b => b.at[0]), [500, 500 - (7 * K), 500 - (14 * K)]);
});

test("a train with no colour uses LOCO", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0)], ""));
	assert.equal(strokes(calls)[0][2], "#eb1200");
});
