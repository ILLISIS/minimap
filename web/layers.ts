// The layers a frame draws (spec §11.5-11.7), on a canvas 2D context in CSS pixels: terrain, edge lines, chart tags,
// recipes and movers, clipped to one instance's bounds when one is selected. Game text (tag text, names) reaches the
// page only through fillText and strokeText (REV M-13).
import { SIZE, type Quad } from "../shared/keys.js";
import { iconIndex, type Icon, type IconMetadata } from "./view/overlays.js";
import type { Entry, Viewer } from "./view/viewer.js";

/** The mod pack export's spritesheet, and its sprites by tag icon ("item/iron-plate") and "recipe/<name>". */
export type Icons = { sheet: CanvasImageSource; at: Map<string, Icon> };

/** Tags show from level 0's scales down; recipes once a machine (3 tiles) is 8 px; names at 1 tile a pixel. */
const TAGS = 2;
const RECIPES = 3 / 8;
const NAMES = 1;
const COLOURS = { t: "#ff5050", v: "#50c8ff", p: "#ffffff" };

/** The export's spritesheet and metadata.json; undefined without them, and text is drawn instead (§11.7). */
export async function loadIcons(png: string, json: string): Promise<Icons | undefined> {
	try {
		const res = await fetch(json);
		const sheet = new Image();
		sheet.src = png;
		await sheet.decode();
		return res.ok ? { sheet, at: iconIndex(await res.json() as IconMetadata) } : undefined;
	} catch {
		// §19 item 14: no export on the cluster, or none in the bucket yet.
		return undefined;
	}
}

/** Map tiles to CSS pixels. */
function screen(v: Viewer, x: number, y: number): [number, number] {
	return [((x - v.view.x) / v.view.s) + (v.width / 2), ((y - v.view.y) / v.view.s) + (v.height / 2)];
}

/** Each decoded area's pixels on a 512 × 512 canvas, redrawn when its version moves on. */
const images = new WeakMap<Entry, { canvas: OffscreenCanvas; version: number }>();

function image(e: Entry): OffscreenCanvas {
	let img = images.get(e);
	if (!img) {
		img = { canvas: new OffscreenCanvas(SIZE, SIZE), version: -1 };
		images.set(e, img);
	}
	if (img.version !== e.version) {
		img.canvas.getContext("2d")!.putImageData(new ImageData(e.rgba, SIZE, SIZE), 0, 0);
		img.version = e.version;
	}
	return img.canvas;
}

/** Text with a dark outline, so it reads on any terrain. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
	ctx.strokeText(text, x, y);
	ctx.fillText(text, x, y);
}

export function draw(ctx: CanvasRenderingContext2D, v: Viewer, icons: Icons | undefined): void {
	const { sel, catalog } = v;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, v.width, v.height);
	const map = sel && catalog?.maps[sel.map];
	const surface = sel && map?.surfaces[sel.surface];
	if (!sel || !map || !surface) {
		return;
	}
	ctx.save();
	// §11.5: one instance's view is the map, clipped to that instance's bounds.
	const bounds = sel.instance === undefined ? undefined : map.instances[sel.instance]?.bounds;
	if (bounds) {
		const [x1, y1] = screen(v, bounds[0], bounds[1]);
		const [x2, y2] = screen(v, bounds[2], bounds[3]);
		ctx.beginPath();
		ctx.rect(x1, y1, x2 - x1, y2 - y1);
		ctx.clip();
	}
	terrain(ctx, v);
	edges(ctx, v, surface.edges);
	ctx.font = "12px sans-serif";
	ctx.textBaseline = "middle";
	ctx.lineWidth = 3;
	ctx.strokeStyle = "#000";
	ctx.fillStyle = "#fff";
	const t = v.time();
	if (v.view.s <= TAGS) {
		for (const [, , , , , x, y, icon, text] of v.tags.at(t)) {
			mark(ctx, v, icons, x, y, 16, icon, text);
		}
	}
	if (v.view.s <= RECIPES) {
		for (const [, , , , , x, y, recipe] of v.recipes.at(t)) {
			mark(ctx, v, icons, x, y, Math.min(32, 3 / v.view.s), `recipe/${recipe}`, "");
		}
	}
	movers(ctx, v);
	ctx.restore();
}

function terrain(ctx: CanvasRenderingContext2D, v: Viewer): void {
	ctx.imageSmoothingEnabled = false;
	for (const { key, a } of v.shown) {
		const e = v.areas.peek(key);
		if (e) {
			const span = SIZE * 2 ** a.z;
			// Rounded edges, so neighbouring areas meet without a seam.
			const [x1, y1] = screen(v, (a.ax * span) - 256, (a.ay * span) - 256).map(Math.round);
			const [x2, y2] = screen(v, ((a.ax + 1) * span) - 256, ((a.ay + 1) * span) - 256).map(Math.round);
			ctx.drawImage(image(e), x1, y1, x2 - x1, y2 - y1);
		}
	}
}

/** §11.6: the catalog's edge lines, 2 px at every zoom. */
function edges(ctx: CanvasRenderingContext2D, v: Viewer, lines: Quad[]): void {
	ctx.strokeStyle = "#ffd700";
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (const [x1, y1, x2, y2] of lines) {
		ctx.moveTo(...screen(v, x1, y1));
		ctx.lineTo(...screen(v, x2, y2));
	}
	ctx.stroke();
}

/** A tag or a machine: its icon `size` px square, or its icon's name as text without one; then its text. */
function mark(
	ctx: CanvasRenderingContext2D, v: Viewer, icons: Icons | undefined, x: number, y: number, size: number,
	icon: string, text: string,
): void {
	const [sx, sy] = screen(v, x, y);
	if (sx < -size || sy < -size || sx > v.width + size || sy > v.height + size) {
		return;
	}
	const sprite = icons?.at.get(icon);
	if (icons && sprite) {
		const [x0, y0] = [sx - (size / 2), sy - (size / 2)];
		ctx.drawImage(icons.sheet, sprite.x, sprite.y, sprite.size, sprite.size, x0, y0, size, size);
	}
	const words = sprite || icon === "" ? text : `${icon.slice(icon.indexOf("/") + 1)} ${text}`.trim();
	if (words !== "") {
		label(ctx, words, sx + (size / 2) + 2, sy);
	}
}

/** §11.7: trains as lines n × 7 tiles long; vehicles and players as dots with a heading, named when zoomed in. */
function movers(ctx: CanvasRenderingContext2D, v: Viewer): void {
	for (const m of v.movers) {
		ctx.strokeStyle = COLOURS[m.kind];
		ctx.fillStyle = COLOURS[m.kind];
		const [sx, sy] = screen(v, m.x, m.y);
		if (m.kind === "t") {
			ctx.lineWidth = Math.max(3, 2 / v.view.s);
			ctx.beginPath();
			for (const [x, y] of m.path) {
				ctx.lineTo(...screen(v, x, y));
			}
			ctx.stroke();
			continue;
		}
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(sx, sy, 4, 0, 2 * Math.PI);
		ctx.fill();
		ctx.beginPath();
		ctx.moveTo(sx, sy);
		ctx.lineTo(sx + (9 * m.hx), sy + (9 * m.hy));
		ctx.stroke();
		if (v.view.s <= NAMES) {
			ctx.strokeStyle = "#000";
			ctx.lineWidth = 3;
			label(ctx, m.name, sx + 8, sy);
		}
	}
}
