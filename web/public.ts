// The public page (spec §3, §10.8, §11.1): the viewer over the bucket it is served from, with plain <select> and
// <input type="range"> controls, the timelapse (§11.4) and "ended" (§11.8). Game text reaches the page only through
// textContent (REV M-13).
import { mount } from "./map_view.js";
import { Clock } from "./view/movers.js";
import { bucketSource } from "./view/source.js";
import { choose, placeOf, places, type Selection } from "./view/viewer.js";

/**
 * §22.2 (M15): the public page draws live movers 16 s behind: its delivery (the 1-s batch, the 5-s live PUT, 5 s of
 * cache and the 5-s poll).
 */
const DELAY = 16_000;

const $ = <T extends HTMLElement = HTMLSelectElement>(id: string) => document.getElementById(id) as T;
const clock = new Clock();
const { viewer } = mount($<HTMLCanvasElement>("canvas"), bucketSource(t => clock.see(t)), DELAY, clock);

/** A select's options from [value, label] pairs; hidden when there is nothing to choose. */
function fill(select: HTMLSelectElement, options: [string, string][], value: string): void {
	select.replaceChildren(...options.map(([v, text]) => {
		const option = document.createElement("option");
		option.value = v;
		option.textContent = text;
		return option;
	}));
	select.value = value;
	select.hidden = options.length < 2;
}

/**
 * §22.1 (M14): the map (each world, then each instance), its surfaces, and the force; `fill` hides a picker with
 * one choice, so the force shows only when the surface has more than one.
 */
function controls(): void {
	const { catalog, sel } = viewer;
	if (!catalog || !sel) {
		return;
	}
	const list = places(catalog);
	const surfaces = list.find(p => p.key === placeOf(sel))?.surfaces ?? [];
	const at = surfaces.findIndex(s => s.map === sel.map && s.surface === sel.surface);
	fill($("map"), list.map(p => [p.key, p.label]), placeOf(sel));
	fill($("surface"), surfaces.map((s, i) => [String(i), s.surface]), String(at));
	fill($("force"), Object.keys(catalog.maps[sel.map].surfaces[sel.surface].forces).map(f => [f, f]), sel.force);
}

function pick(want: Partial<Selection> | undefined): void {
	const next = viewer.catalog && want && choose(viewer.catalog, { force: viewer.sel?.force, ...want });
	if (next) {
		viewer.select(next);
	} else {
		controls(); // no such choice: the controls show the selection again
	}
}

/** Surface i of the first picker's entry `key`. */
function entry(key: string, i: number): Partial<Selection> | undefined {
	return viewer.catalog && places(viewer.catalog).find(p => p.key === key)?.surfaces[i];
}

$("map").addEventListener("change", () => pick(entry($("map").value, 0)));
$("surface").addEventListener("change", () => {
	pick(viewer.sel && entry(placeOf(viewer.sel), Number($("surface").value)));
});
$("force").addEventListener("change", () => pick({ ...viewer.sel, force: $("force").value }));

let shown: unknown[] = [];
viewer.subscribe(() => {
	// Once per catalog or selection: the controls aren't rebuilt at every played frame.
	if (viewer.catalog && viewer.sel && (shown[0] !== viewer.catalog || shown[1] !== viewer.sel)) {
		shown = [viewer.catalog, viewer.sel];
		controls();
	}
});

// §11.4: the timelapse; §11.8: "ended".
const slider = $<HTMLInputElement>("slider");
slider.addEventListener("input", () => {
	const t = Number(slider.value);
	viewer.seek(t >= Number(slider.max) ? undefined : t);
});
$("play").addEventListener("click", () => viewer.play(viewer.speed > 0 ? 0 : Number($("speed").value)));
$("speed").addEventListener("change", () => {
	if (viewer.speed > 0) {
		viewer.play(Number($("speed").value));
	}
});
$("live").addEventListener("click", () => viewer.seek(undefined));
viewer.subscribe(() => {
	const [first, now] = viewer.range();
	slider.min = String(first);
	slider.max = String(now);
	slider.value = String(viewer.at ?? now);
	$("play").textContent = viewer.speed > 0 ? "Pause" : "Play";
	const ended = viewer.ended();
	let status = viewer.at === undefined ? "Live" : new Date(viewer.at).toLocaleString();
	if (ended !== undefined) {
		status = `${status}. Ended at ${new Date(ended).toLocaleString()}`;
	}
	$("status").textContent = status;
});
