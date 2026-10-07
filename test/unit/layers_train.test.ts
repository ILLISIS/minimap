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

test("one carriage: an outline in the train's colour 0.45 tile thick, a #f9ce3e fill", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0)]));
	const s = strokes(calls)[0];
	assert.equal(s[2], "#00ff00");
	assert.equal(s[3], 0.45 * 16);
	assert.ok(calls.some(c => c[0] === "fill" && c[1] === "#f9ce3e"));
});

test("the outline is at least 1 px and the box never under 3 x 2 px when far out", () => {
	const { ctx, calls } = fake();
	train(ctx, { ...view, view: { x: 0, y: 0, s: 64 } } as Viewer, shown([car(0), car(7)]));
	assert.equal(Math.min(...strokes(calls).map(c => c[3] as number)), 1);
	const lines = calls.filter(c => c[0] === "lineTo").map(c => c[1] as number);
	assert.ok(Math.max(...lines) - Math.min(...lines) >= 3 - 1e-9);
});

test("three carriages draw two bars, 0.75 tile thick in the train's colour", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0), car(-7), car(-14)]));
	const bars = strokes(calls).filter(c => c[3] === 0.75 * 16);
	assert.equal(bars.length, 2);
	assert.equal(bars[0][2], "#00ff00");
});

test("the leading carriage's path has five points, its point 1.2 tiles ahead of the front edge along a", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0, 0.5), car(-7, 0.5)]));
	const save = calls.findIndex(c => c[0] === "save");
	const first = calls.findIndex((c, i) => i > save && c[0] === "beginPath");
	const rotate = calls.find(c => c[0] === "rotate");
	assert.equal(rotate?.[1], 0.5);
	const end = calls.findIndex((c, i) => i > first && c[0] === "closePath");
	const pts = calls.slice(first, end).filter(c => c[0] === "moveTo" || c[0] === "lineTo")
		.map(c => [c[1], c[2]] as [number, number]);
	assert.equal(pts.length, 5);
	const tip = pts.find(p => p[1] === 0)!;
	assert.ok(Math.abs(tip[0] - pts[1][0] - (1.2 * 16)) < 1e-9);
});

test("a train with no colour uses LOCO", () => {
	const { ctx, calls } = fake();
	train(ctx, view, shown([car(0)], ""));
	assert.equal(strokes(calls)[0][2], "#eb1200");
});
