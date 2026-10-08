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

/** A locomotive Lua sent no colour for: base's (data/base/prototypes/entity/trains.lua:607). */
export const LOCO = "#eb1200";
const FILL = "#f9ce3e";
// Measured from the owner's screenshot of the in-game map (§22.4), in tiles.
const LENGTH = 4.9;
const WIDTH = 2.5;
const OUTLINE = 0.45;
const BAR = 0.75;
/** Where the leading carriage's sides stop and slant to its point, from its back (§22.4). */
const SHOULDER = 2.5;

/**
 * §22.4: per carriage a box outlined in the train's colour (at least 1 px), bars in that colour to the next carriage,
 * and an arrow point on the leading one (cars[0]), which keeps the same length. Never under 3 × 2 px, so a far train
 * still shows.
 */
export function train(ctx: Pen, v: Viewer, m: Shown): void {
	const k = 1 / v.view.s;
	const [l, w] = [Math.max(LENGTH * k, 3), Math.max(WIDTH * k, 2)];
	const o = Math.max(OUTLINE * k, 1);
	const colour = m.colour === "" ? LOCO : `#${m.colour}`;
	const at = (x: number, y: number): [number, number] => [
		((x - v.view.x) * k) + (v.width / 2), ((y - v.view.y) * k) + (v.height / 2),
	];
	ctx.strokeStyle = colour;
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
	m.cars.forEach((c, i) => {
		ctx.save();
		ctx.translate(...at(c.x, c.y));
		ctx.rotate(c.a);
		// The path runs through the middle of the outline, so it is inset half its width from the box's edge.
		const [hl, hw] = [(l - o) / 2, (w - o) / 2];
		ctx.beginPath();
		ctx.moveTo(-hl, -hw);
		if (i === 0) {
			// The point replaces the box's front part: sides run to the shoulder, then slant to the front centre.
			const sx = -(l / 2) + (l * SHOULDER / LENGTH);
			ctx.lineTo(sx, -hw);
			ctx.lineTo(hl, 0);
			ctx.lineTo(sx, hw);
		} else {
			ctx.lineTo(hl, -hw);
			ctx.lineTo(hl, hw);
		}
		ctx.lineTo(-hl, hw);
		ctx.closePath();
		ctx.fillStyle = FILL;
		ctx.fill();
		ctx.lineJoin = "miter";
		ctx.lineWidth = o;
		ctx.stroke();
		ctx.restore();
	});
}
