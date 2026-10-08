import assert from "node:assert/strict";
import { test } from "node:test";
import { vehicle } from "../../web/view/vehicle.js";
import type { Pen } from "../../web/view/train.js";
import type { Shown } from "../../web/view/movers.js";
import type { Viewer } from "../../web/view/viewer.js";

type Call = [string, ...unknown[]];

/** A 2D context that records each call and the style/width in force at it. */
function fake() {
	const calls: Call[] = [];
	const ctx = { fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "" } as Record<string, unknown>;
	const names = [
		"save", "restore", "translate", "rotate", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc",
	];
	for (const name of names) {
		ctx[name] = (...a: unknown[]) => {
			calls.push([name, ...a, ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth]);
		};
	}
	return { ctx: ctx as unknown as Pen, calls };
}

const at = (s: number) => ({ view: { x: 0, y: 0, s }, width: 1000, height: 1000 }) as Viewer;
const K = 16;
const base = { x: 0, y: 0, hx: 0, hy: -1, colour: "00ff00" };
const shown = (kinds: string, o: Partial<Shown> = {}): Shown => ({ ...base, kinds, ...o }) as Shown;
const pts = (calls: Call[]) => calls.filter(c => c[0] === "moveTo" || c[0] === "lineTo")
	.map(c => [c[1], c[2]] as [number, number]);
const extent = (p: [number, number][], axis: 0 | 1) => {
	const a = p.map(q => q[axis]);
	return Math.max(...a) - Math.min(...a);
};

test("a car: a triangle 4.7 x 4.8 tiles outer, #e5e5e5, outlined 0.5 tile in its colour", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("C"));
	const p = pts(calls);
	assert.equal(p.length, 3);
	assert.ok(Math.abs(extent(p, 0) + (0.5 * K) - (4.7 * K)) < 1e-9);
	assert.ok(Math.abs(extent(p, 1) + (0.5 * K) - (4.8 * K)) < 1e-9);
	assert.ok(calls.some(c => c[0] === "fill" && c[1] === "#e5e5e5"));
	const s = calls.find(c => c[0] === "stroke") as Call;
	assert.equal(s[2], "#00ff00");
	assert.equal(s[3], 0.5 * K);
});

test("a car's point goes along its heading: east turns the north-pointing triangle a quarter turn", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("C", { hx: 1, hy: 0 }));
	assert.equal(calls.find(c => c[0] === "rotate")?.[1], Math.PI / 2);
	const p = pts(calls);
	assert.ok(p[0][1] < p[1][1], "its first point, the tip, is the most forward in local y");
});

test("no colour: base's locomotive red", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("C", { colour: "" }));
	assert.equal((calls.find(c => c[0] === "stroke") as Call)[2], "#eb1200");
});

test("a spidertron: a white disc 4.4 tiles across and 8 legs reaching 5.7 tiles, outlined in its colour", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("S"));
	const arc = calls.find(c => c[0] === "arc") as Call;
	assert.equal(arc[3], 2.2 * K);
	assert.equal(arc[6], "#ffffff");
	assert.equal(calls.filter(c => c[0] === "moveTo").length, 8);
	const reach = Math.max(...pts(calls).map(([x, y]) => Math.hypot(x, y)));
	assert.ok(Math.abs(reach - (5.7 * K)) < 1e-9);
	assert.ok(calls.filter(c => c[0] === "stroke").every(c => c[2] === "#00ff00" && c[3] === 0.5 * K));
	assert.equal(calls.some(c => c[0] === "rotate"), false, "it is not turned");
});

test("far out a vehicle stays 8 px across", () => {
	const car = fake();
	vehicle(car.ctx, at(4), shown("C"));
	const p = pts(car.calls);
	assert.ok(extent(p, 0) + 1 >= 8 - 1e-9 && extent(p, 1) + 1 >= 8 - 1e-9);
	const spider = fake();
	vehicle(spider.ctx, at(4), shown("S"));
	assert.ok(Math.max(...pts(spider.calls).map(([x, y]) => Math.hypot(x, y))) >= 4 - 1e-9);
});
