import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Select, Slider, Space } from "antd";
import { PageHeader, PageLayout } from "@clusterio/web_ui";
import { mount, type Mounted } from "./map_view.js";
import type { Source } from "./view/source.js";
import { choose, type Selection, type Viewer } from "./view/viewer.js";

/** §22.2 (M15): the Clusterio page draws live movers 2 s behind, past their ≈ 1-s delivery (§7.3). */
const DELAY = 2000;

/** Re-render on the viewer's changes: the catalog, the selection, the time shown. */
function useViewer(viewer: Viewer): void {
	useSyncExternalStore(cb => viewer.subscribe(cb), () => viewer.rev);
}

/** Map, surface, force and instance (§3). Names are React text, never HTML (REV M-13). */
function Pickers({ viewer }: { viewer: Viewer }) {
	useViewer(viewer);
	const { catalog, sel } = viewer;
	if (!catalog || !sel) {
		return null;
	}
	const map = catalog.maps[sel.map];
	const pick = (want: Partial<Selection>) => {
		const next = choose(catalog, want);
		if (next) {
			viewer.select(next);
		}
	};
	const instances = Object.entries(map.instances).filter(([, i]) => i.bounds);
	return <Space wrap>
		<Select
			style={{ minWidth: 160 }} value={sel.map} onChange={m => pick({ map: m })}
			options={Object.entries(catalog.maps).map(([id, m]) => ({ value: id, label: m.title }))}
		/>
		<Select
			style={{ minWidth: 120 }} value={sel.surface} onChange={s => pick({ ...sel, surface: s })}
			options={Object.keys(map.surfaces).map(s => ({ value: s, label: s }))}
		/>
		<Select
			style={{ minWidth: 100 }} value={sel.force} onChange={f => pick({ ...sel, force: f })}
			options={Object.keys(map.surfaces[sel.surface].forces).map(f => ({ value: f, label: f }))}
		/>
		{instances.length > 1 && <Select
			style={{ minWidth: 160 }} value={sel.instance ?? ""}
			onChange={i => pick({ ...sel, instance: i || undefined })}
			options={[{ value: "", label: "Whole map" }, ...instances.map(([id, i]) => ({ value: id, label: i.name }))]}
		/>}
	</Space>;
}

const SPEEDS: [number, string][] = [
	[60, "1 min/s"], [600, "10 min/s"], [3600, "1 h/s"], [21_600, "6 h/s"], [86_400, "1 day/s"],
];

/** The timelapse (§11.4): a slider over [first, now] on wall-clock time, played at a minute to a day a second. */
function Timelapse({ viewer }: { viewer: Viewer }) {
	useViewer(viewer);
	const [speed, setSpeed] = useState(3600);
	const [first, now] = viewer.range();
	if (!viewer.sel || !Number.isFinite(now)) {
		return null;
	}
	const playing = viewer.speed > 0;
	return <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
		<Slider
			min={first} max={now} value={viewer.at ?? now} tooltip={{ open: false }}
			onChange={t => viewer.seek(t >= now ? undefined : t)}
		/>
		<Space wrap>
			<Button onClick={() => viewer.play(playing ? 0 : speed)}>{playing ? "Pause" : "Play"}</Button>
			<Select
				style={{ width: 110 }} value={speed} options={SPEEDS.map(([value, label]) => ({ value, label }))}
				onChange={s => {
					setSpeed(s);
					if (playing) {
						viewer.play(s);
					}
				}}
			/>
			<Button disabled={viewer.at === undefined} onClick={() => viewer.seek(undefined)}>Live</Button>
			<span>{viewer.at === undefined ? "Live" : new Date(viewer.at).toLocaleString()}</span>
		</Space>
	</Space>;
}

/** The Clusterio page (spec §3, §11.1): the viewer over the controller's routes and live subscription. */
export default function MinimapPage({ source }: { source: Source }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [mounted, setMounted] = useState<Mounted>();
	useEffect(() => {
		const m = mount(canvas.current!, source, DELAY);
		setMounted(m);
		return m.stop;
	}, [source]);
	return <PageLayout nav={[{ name: "Minimap" }]}>
		<PageHeader title="Minimap" extra={mounted && <Pickers viewer={mounted.viewer} />} />
		<canvas
			ref={canvas}
			style={{ display: "block", width: "100%", height: "70vh", background: "#000", touchAction: "none" }}
		/>
		{mounted && <Timelapse viewer={mounted.viewer} />}
	</PageLayout>;
}
