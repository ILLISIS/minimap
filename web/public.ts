// The public page (spec §3, §10.8, §11.1): the viewer over the bucket it is served from, with plain <select> and
// <input type="range"> controls. Game text reaches the page only through textContent (REV M-13).
import { mount } from "./map_view.js";
import { Clock } from "./view/movers.js";
import { bucketSource } from "./view/source.js";
import { choose, type Selection } from "./view/viewer.js";

const $ = <T extends HTMLElement = HTMLSelectElement>(id: string) => document.getElementById(id) as T;
const clock = new Clock();
const { viewer } = mount($<HTMLCanvasElement>("canvas"), bucketSource(t => clock.see(t)), clock);

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

function pick(want: Partial<Selection>): void {
	const next = viewer.catalog && choose(viewer.catalog, want);
	if (next) {
		viewer.select(next);
	}
}

$("map").addEventListener("change", () => pick({ map: $("map").value }));
$("surface").addEventListener("change", () => pick({ ...viewer.sel, surface: $("surface").value }));
$("force").addEventListener("change", () => pick({ ...viewer.sel, force: $("force").value }));
$("instance").addEventListener("change", () => pick({ ...viewer.sel, instance: $("instance").value || undefined }));

let shown: unknown[] = [];
viewer.subscribe(() => {
	const { catalog, sel } = viewer;
	// Once per catalog or selection: the controls aren't rebuilt at every played frame.
	if (!catalog || !sel || (shown[0] === catalog && shown[1] === sel)) {
		return;
	}
	shown = [catalog, sel];
	const map = catalog.maps[sel.map];
	fill($("map"), Object.entries(catalog.maps).map(([id, m]) => [id, m.title]), sel.map);
	fill($("surface"), Object.keys(map.surfaces).map(s => [s, s]), sel.surface);
	fill($("force"), Object.keys(map.surfaces[sel.surface].forces).map(f => [f, f]), sel.force);
	const instances = Object.entries(map.instances).filter(([, i]) => i.bounds);
	const named = instances.map(([id, i]): [string, string] => [id, i.name]);
	fill($("instance"), [["", "Whole map"], ...named], sel.instance ?? "");
});
