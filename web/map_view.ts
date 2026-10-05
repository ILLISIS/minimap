// The map on a canvas (spec §11.2, K16): the canvas's size, pan by dragging, zoom by the wheel about the pointer,
// frames through requestAnimationFrame, and the catalog's refresh every 60 s (§11.3), wired to a Viewer. Pan and zoom
// by hand instead of a map library.
import { draw, loadIcons, type Icons } from "./layers.js";
import { Clock } from "./view/movers.js";
import type { Source } from "./view/source.js";
import { MAX_SCALE, MIN_SCALE } from "./view/terrain.js";
import { Viewer } from "./view/viewer.js";

export type Mounted = { viewer: Viewer; stop(): void };

/** Wire `canvas` (sized by its CSS) to a viewer of `source`; a bucket source shares the data clock (plan ruling 3). */
export function mount(canvas: HTMLCanvasElement, source: Source, clock = new Clock()): Mounted {
	const ctx = canvas.getContext("2d")!;
	let icons: Icons | undefined;
	const viewer = new Viewer(source, clock, cb => requestAnimationFrame(cb), v => {
		// Device pixels, sized at each frame: moving to a screen of another density resizes no element.
		const dpr = window.devicePixelRatio || 1;
		const [w, h] = [Math.round(v.width * dpr), Math.round(v.height * dpr)];
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw(ctx, v, icons);
	});
	const observer = new ResizeObserver(() => viewer.resize(canvas.clientWidth, canvas.clientHeight));
	observer.observe(canvas);

	let drag: { id: number; x: number; y: number } | undefined;
	canvas.addEventListener("pointerdown", e => {
		if (e.button !== 0 || drag) {
			return;
		}
		drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener("pointermove", e => {
		if (drag?.id === e.pointerId) {
			const { x, y, s } = viewer.view;
			viewer.move({ x: x - ((e.clientX - drag.x) * s), y: y - ((e.clientY - drag.y) * s), s });
			drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
		}
	});
	const end = (e: PointerEvent) => {
		if (drag?.id === e.pointerId) {
			drag = undefined;
		}
	};
	canvas.addEventListener("pointerup", end);
	canvas.addEventListener("pointercancel", end);
	// The map point under the pointer stays under it. ponytail: no pinch zoom; touch pans.
	canvas.addEventListener("wheel", e => {
		e.preventDefault();
		const { x, y, s } = viewer.view;
		const r = canvas.getBoundingClientRect();
		// Firefox's wheel reports lines (and pages), not pixels.
		const lines = { [WheelEvent.DOM_DELTA_LINE]: 16, [WheelEvent.DOM_DELTA_PAGE]: r.height }[e.deltaMode] ?? 1;
		const dy = e.deltaY * lines;
		const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (2 ** (dy / 500))));
		const px = e.clientX - r.left - (r.width / 2);
		const py = e.clientY - r.top - (r.height / 2);
		viewer.move({ x: x + (px * (s - next)), y: y + (py * (s - next)), s: next });
	}, { passive: false });

	// §11.7: the export's icons, once the catalog names them (R2); text until then, or without an export.
	let named = false;
	viewer.subscribe(() => {
		const files = viewer.catalog?.icons;
		if (files && !named) {
			named = true;
			loadIcons(source.icon(files.png), source.icon(files.json)).then(next => {
				icons = next;
				viewer.invalidate();
			}, () => {});
		}
	});

	const refresh = () => {
		// ponytail: a failed catalog fetch keeps the old one; the next refresh tries again.
		viewer.refresh().catch(() => {});
	};
	refresh();
	const timer = setInterval(refresh, 60_000);
	return {
		viewer,
		stop() {
			clearInterval(timer);
			observer.disconnect();
			viewer.close();
		},
	};
}
