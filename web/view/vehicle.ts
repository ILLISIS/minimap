// §22.5: a car, tank or spidertron as the in-game map draws it, on a canvas 2D context in CSS pixels (DOM-free, so node
// tests run it against a recording context).
import { LOCO, type Pen } from "./train.js";
import type { Shown } from "./movers.js";
import type { Viewer } from "./viewer.js";

// Measured from the owner's screenshot of the in-game map (§22.5), in tiles.
// Outer sizes, outline included (§22.5), in tiles.
const LENGTH = 4.78;
const WIDTH = 4.65;
const OUTLINE = 0.5;
const DISC = 2.2;
/** A leg: a four-point kite in its own frame, (DISC, 0), (BELLY, +-HALF), (TIP, 0); outer reach TIP + OUTLINE. */
const BELLY = 3.8;
const HALF = 0.55;
const TIP = 5.2;
const REACH = TIP + OUTLINE;
/** A leg's angle above or below the horizontal, four a side. */
const FAN = [-35, -10, 10, 35].map(d => d * Math.PI / 180);
/** Pixels across, at least. */
const MIN = 8;

/**
 * §22.5: kinds "S" a spidertron (a white disc with 8 pointed legs, not turned), anything else a car's triangle
 * (#e5e5e5, its point along the heading); outlined in the vehicle's colour, else base's locomotive red. Never under
 * 8 px across.
 */
export function vehicle(ctx: Pen, v: Viewer, m: Shown): void {
	const k = 1 / v.view.s;
	const o = Math.max(OUTLINE * k, 1);
	ctx.save();
	ctx.translate(((m.x - v.view.x) * k) + (v.width / 2), ((m.y - v.view.y) * k) + (v.height / 2));
	ctx.strokeStyle = m.colour === "" ? LOCO : `#${m.colour}`;
	ctx.lineWidth = o;
	ctx.lineJoin = "miter";
	let draw: () => void = () => undefined;
	if (m.kinds === "S") {
		const p = Math.max(k, MIN / (2 * REACH));
		const legs = (): void => {
			for (const side of [1, -1]) {
				for (const a of FAN) {
					const [c, n] = [side * Math.cos(a), Math.sin(a)];
					// the leg's frame: x along (c, n), y across (-n, c)
					const at = (x: number, y: number): [number, number] => [(x * c) - (y * n), (x * n) + (y * c)];
					ctx.beginPath();
					ctx.moveTo(...at(DISC * p, 0));
					ctx.lineTo(...at(BELLY * p, HALF * p));
					ctx.lineTo(...at(TIP * p, 0));
					ctx.lineTo(...at(BELLY * p, -HALF * p));
					ctx.closePath();
					draw();
				}
			}
			ctx.beginPath();
			ctx.arc(0, 0, DISC * p, 0, 2 * Math.PI);
			draw();
		};
		// One outline around the silhouette: stroke every part at twice the width, then fill them over it, so no
		// outline shows inside, and the round joins keep a leg's tip at TIP + OUTLINE.
		ctx.lineJoin = "round";
		ctx.lineWidth = 2 * o;
		draw = () => ctx.stroke();
		legs();
		ctx.fillStyle = "#ffffff";
		draw = () => ctx.fill();
		legs();
	} else {
		// The outline is mitred, so the path is the outer triangle scaled in about its incentre by half the outline.
		const [w, l] = [Math.max(WIDTH * k, MIN), Math.max(LENGTH * k, MIN)];
		const leg = Math.hypot(w / 2, l);
		const r = w * l / (w + (2 * leg));
		const f = (r - (o / 2)) / r;
		const [top, bottom] = [-(l / 2), (l / 2)];
		// the incentre sits r above the base
		const iy = bottom - r;
		const [ty, by] = [iy + ((top - iy) * f), iy + ((bottom - iy) * f)];
		const hw = w / 2 * f;
		ctx.rotate(Math.atan2(m.hx, -m.hy));
		ctx.fillStyle = "#e5e5e5";
		ctx.beginPath();
		ctx.moveTo(0, ty);
		ctx.lineTo(hw, by);
		ctx.lineTo(-hw, by);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();
}
