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
			calls.push([name, ...a, ctx.fillStyle, ctx.strokeStyle, ctx.lineWidth, ctx.lineJoin]);
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

/** The outer size of a mitred triangle outline: the path scaled out about its incentre by half the outline. */
function outer(p: [number, number][], o: number): [number, number] {
	const [a, b, c] = p;
	const [la, lb, lc] = [Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(a[0] - c[0], a[1] - c[1]),
		Math.hypot(a[0] - b[0], a[1] - b[1])];
	const sum = la + lb + lc;
	const [ix, iy] = [(la * a[0] + lb * b[0] + lc * c[0]) / sum, (la * a[1] + lb * b[1] + lc * c[1]) / sum];
	const r = Math.abs(((b[0] - a[0]) * (c[1] - a[1])) - ((c[0] - a[0]) * (b[1] - a[1]))) / sum;
	const f = (r + (o / 2)) / r;
	const q = p.map(([x, y]): [number, number] => [ix + ((x - ix) * f), iy + ((y - iy) * f)]);
	return [extent(q, 0), extent(q, 1)];
}

test("a car: a triangle 4.65 x 4.78 tiles outer, #e5e5e5, outlined 0.5 tile in #ff1a1a whatever its colour", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("C"));
	const p = pts(calls);
	assert.equal(p.length, 3);
	const [w, l] = outer(p, 0.5 * K);
	assert.ok(Math.abs(w - (4.65 * K)) < 1e-6 && Math.abs(l - (4.78 * K)) < 1e-6, `${w / K} x ${l / K}`);
	assert.ok(calls.some(c => c[0] === "fill" && c[1] === "#e5e5e5"));
	const s = calls.find(c => c[0] === "stroke") as Call;
	assert.equal(s[2], "#ff1a1a");
	assert.equal(s[3], 0.5 * K);
});

test("the outline is never under 1 px", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(8), shown("C"));
	assert.equal((calls.find(c => c[0] === "stroke") as Call)[3], 1);
});

test("a car's point goes along its heading: east turns the north-pointing triangle a quarter turn", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("C", { hx: 1, hy: 0 }));
	assert.equal(calls.find(c => c[0] === "rotate")?.[1], Math.PI / 2);
	const p = pts(calls);
	assert.ok(p[0][1] < p[1][1], "its first point, the tip, is the most forward in local y");
});

test("a spidertron: a white disc 4.4 tiles across, 8 petal legs at 10 and 35 degrees, reach 5.7", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("S"));
	const arc = calls.filter(c => c[0] === "arc").pop() as Call;
	assert.equal(arc[3], 2.2 * K);
	assert.equal(arc[6], "#ffffff");
	const tips = new Set<string>();
	const paths = new Set<string>();
	let reach = 0;
	for (let i = 0; i < calls.length; i++) {
		const c = calls[i];
		if (c[0] === "moveTo") {
			const [t1, t2, t3] = [calls[i + 1], calls[i + 2], calls[i + 3]];
			assert.ok([t1, t2, t3].every(q => q[0] === "lineTo") && calls[i + 4][0] === "closePath");
			const tip = t2 as unknown as [string, number, number];
			const deg = Math.atan2(tip[2], Math.abs(tip[1])) * 180 / Math.PI;
			tips.add(`${Math.round(deg)} ${Math.sign(tip[1])}`);
			paths.add(`${c[1]} ${c[2]}`);
			reach = Math.max(reach, Math.hypot(tip[1], tip[2]));
		}
	}
	assert.equal(paths.size, 8, "8 leg paths");
	assert.deepEqual([...tips].sort(),
		["-10 -1", "-10 1", "-35 -1", "-35 1", "10 -1", "10 1", "35 -1", "35 1"], "+-10 and +-35 each side");
	assert.ok(Math.abs(reach + (0.5 * K) - (5.7 * K)) < 1e-6, `outer reach ${(reach + (0.5 * K)) / K}`);
	assert.equal(calls.some(c => c[0] === "rotate"), false, "it is not turned");
});

test("a spidertron is outlined once around the whole shape: every stroke before every fill, 1 tile wide", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("S"));
	const last = calls.map(c => c[0]).lastIndexOf("stroke");
	assert.ok(last < calls.findIndex(c => c[0] === "fill"), "no stroke over a fill, so no ring over a leg root");
	assert.ok(calls.filter(c => c[0] === "stroke").every(c => c[2] === "#ff1a1a" && c[3] === K));
});

test("the two legs 10 degrees off the horizontal on one side stay apart at their widest points", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("S"));
	const belly: [number, number][] = [];
	for (let i = 0; i < calls.length; i++) {
		// a leg: moveTo, lineTo belly+, lineTo tip, lineTo belly-
		if (calls[i][0] === "moveTo" && (calls[i][1] as number) > 0 && Math.abs(calls[i][2] as number) < 0.5 * K) {
			const [a, b] = [calls[i + 1], calls[i + 3]];
			belly.push([((a[1] as number) + (b[1] as number)) / 2, ((a[2] as number) + (b[2] as number)) / 2]);
			belly.push([Math.hypot((a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number)), 0]);
		}
	}
	assert.equal(belly.length, 8, "the two legs at +-10 on the right, stroked then filled");
	belly.length = 4;
	const gap = Math.hypot(belly[0][0] - belly[2][0], belly[0][1] - belly[2][1]);
	assert.ok(gap >= (belly[1][0] + belly[3][0]) / 2, `centres ${gap / K} apart, kites ${belly[1][0] / K} wide`);
});

test("the spider's outline has round joins, so a leg's tip does not mitre out", () => {
	const { ctx, calls } = fake();
	vehicle(ctx, at(1 / K), shown("S"));
	assert.ok(calls.filter(c => c[0] === "stroke").every(c => c[4] === "round"));
});

test("far out a vehicle stays 8 px across", () => {
	const car = fake();
	vehicle(car.ctx, at(4), shown("C"));
	const p = pts(car.calls);
	const [w, l] = outer(p, 1);
	assert.ok(w >= 8 - 1e-9 && l >= 8 - 1e-9, `${w} x ${l}`);
	const spider = fake();
	vehicle(spider.ctx, at(4), shown("S"));
	assert.ok(Math.max(...pts(spider.calls).map(([x, y]) => Math.hypot(x, y))) + 1 >= 4 - 1e-9);
});
