// §22.5: a car, tank or spidertron as the in-game map draws it, on a canvas 2D context in CSS pixels (DOM-free, so node
// tests run it against a recording context).
import { LOCO, type Pen } from "./train.js";
import type { Shown } from "./movers.js";
import type { Viewer } from "./viewer.js";

// Measured from the owner's screenshot of the in-game map (§22.5), in tiles.
const LENGTH = 4.8;
const WIDTH = 4.7;
const OUTLINE = 0.5;
const DISC = 2.2;
const REACH = 5.7;
/** A leg's angle above or below the horizontal, four a side; and its width at the disc. */
const FAN = [-60, -20, 20, 60].map(d => d * Math.PI / 180);
const LEG = 0.9;
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
	if (m.kinds === "S") {
		const p = Math.max(k, MIN / (2 * REACH));
		ctx.fillStyle = "#ffffff";
		for (const side of [1, -1]) {
			for (const a of FAN) {
				const [c, s] = [side * Math.cos(a), Math.sin(a)];
				ctx.beginPath();
				ctx.moveTo(c * DISC * p + (s * LEG * p / 2), s * DISC * p - (c * LEG * p / 2));
				ctx.lineTo(c * REACH * p, s * REACH * p);
				ctx.lineTo(c * DISC * p - (s * LEG * p / 2), s * DISC * p + (c * LEG * p / 2));
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
			}
		}
		ctx.beginPath();
		ctx.arc(0, 0, DISC * p, 0, 2 * Math.PI);
		ctx.fill();
		ctx.stroke();
	} else {
		// The path runs through the middle of the outline, so it is inset half its width from the edge.
		const [hl, hw] = [(Math.max(LENGTH * k, MIN) - o) / 2, (Math.max(WIDTH * k, MIN) - o) / 2];
		ctx.rotate(Math.atan2(m.hx, -m.hy));
		ctx.fillStyle = "#e5e5e5";
		ctx.beginPath();
		ctx.moveTo(0, -hl);
		ctx.lineTo(hw, hl);
		ctx.lineTo(-hw, hl);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();
}
