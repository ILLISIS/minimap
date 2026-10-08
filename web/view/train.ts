// §22.4: a train as the in-game map draws it, on a canvas 2D context in CSS pixels (kept out of layers.ts so node
// tests can run it against a recording context).
import type { Shown } from "./movers.js";
import type { Viewer } from "./viewer.js";

/** The slice of CanvasRenderingContext2D the drawing uses. */
export type Pen = {
	fillStyle: string | object; strokeStyle: string | object; lineWidth: number; lineJoin: string;
	save(): void; restore(): void; translate(x: number, y: number): void; rotate(a: number): void;
	beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
	arc(x: number, y: number, r: number, a0: number, a1: number): void;
	fill(): void; stroke(): void;
};

// The game's chart colours (data/core/prototypes/utility-constants.lua), bar the fill, which is measured (§22.6).
// ponytail: constants; read prototypes.utility_constants at the config so a mod's colours carry over.
/** `vehicle_outer_color` and `vehicle_wagon_connection_color`, shared with vehicle.ts. */
export const OUTLINE_COLOUR = "#ff1a1a";
const FILL = "#f9ce3e";
// Measured from the owner's screenshot of the in-game map (§22.6), in tiles.
const LENGTH = 4.9;
const WIDTH = 2.4;
const OUTLINE = 0.5;
const BAR = 0.8;
/** Where a locomotive's sides stop and slant to its point, from its back. */
const SHOULDER = 2.5;

/**
 * §22.6: per carriage its shape by kind (L locomotive, F fluid wagon, A artillery wagon, anything else a box), turned
 * along the path, its front the way the path runs for an upper-case letter and against it for a lower-case one;
 * outlined, with bars to the next carriage, all in #ff1a1a. Never under 3 x 2 px, so a far train still shows.
 */
export function train(ctx: Pen, v: Viewer, m: Shown): void {
	const k = 1 / v.view.s;
	const [l, w] = [Math.max(LENGTH * k, 3), Math.max(WIDTH * k, 2)];
	const o = Math.max(OUTLINE * k, 1);
	const at = (x: number, y: number): [number, number] => [
		((x - v.view.x) * k) + (v.width / 2), ((y - v.view.y) * k) + (v.height / 2),
	];
	ctx.strokeStyle = OUTLINE_COLOUR;
	ctx.lineWidth = Math.max(BAR * k, 1);
	for (let i = 1; i < m.cars.length; i++) {
		const [a, b] = [at(m.cars[i - 1].x, m.cars[i - 1].y), at(m.cars[i].x, m.cars[i].y)];
		const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
		const [ux, uy] = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
		ctx.beginPath();
		ctx.moveTo(a[0] + (ux * l / 2), a[1] + (uy * l / 2));
		ctx.lineTo(b[0] - (ux * l / 2), b[1] - (uy * l / 2));
		ctx.stroke();
	}
	// The path runs through the middle of the outline, so it is inset half its width from the box's edge.
	const [hl, hw] = [(l - o) / 2, (w - o) / 2];
	const finish = (): void => {
		ctx.fillStyle = FILL;
		ctx.fill();
		ctx.strokeStyle = OUTLINE_COLOUR;
		ctx.lineJoin = "miter";
		ctx.lineWidth = o;
		ctx.stroke();
	};
	for (const c of m.cars) {
		ctx.save();
		ctx.translate(...at(c.x, c.y));
		ctx.rotate(c.a);
		const kind = c.kind.toUpperCase();
		const f = c.kind === kind ? 1 : -1; // the front's side along x
		ctx.beginPath();
		if (kind === "L") {
			const sx = f * (-(l / 2) + (l * SHOULDER / LENGTH));
			ctx.moveTo(-f * hl, -hw);
			ctx.lineTo(sx, -hw);
			ctx.lineTo(f * hl, 0);
			ctx.lineTo(sx, hw);
			ctx.lineTo(-f * hl, hw);
			ctx.closePath();
		} else if (kind === "F") {
			const e = Math.max(hl - hw, 0);
			ctx.moveTo(-e, -hw);
			ctx.lineTo(e, -hw);
			ctx.arc(e, 0, hw, -Math.PI / 2, Math.PI / 2);
			ctx.lineTo(-e, hw);
			ctx.arc(-e, 0, hw, Math.PI / 2, 3 * Math.PI / 2);
			ctx.closePath();
		} else if (kind === "A") {
			// the barrel first, from the disc's centre to the front, so the disc covers its back end
			const [cx, hb] = [-f * (hl - hw), Math.max(((w / 3) - o) / 2, 0)];
			ctx.moveTo(cx, -hb);
			ctx.lineTo(f * hl, -hb);
			ctx.lineTo(f * hl, hb);
			ctx.lineTo(cx, hb);
			ctx.closePath();
			finish();
			ctx.beginPath();
			ctx.arc(cx, 0, hw, 0, 2 * Math.PI);
		} else {
			ctx.moveTo(-hl, -hw);
			ctx.lineTo(hl, -hw);
			ctx.lineTo(hl, hw);
			ctx.lineTo(-hl, hw);
			ctx.closePath();
		}
		finish();
		ctx.restore();
	}
}
