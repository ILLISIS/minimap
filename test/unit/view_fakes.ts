// Helpers for the viewer's tests (not a test file): a source over a map of keys, a frame queue, a settle loop, and a
// catalog of one map surface.
import type { Catalog, SurfaceInfo } from "../../shared/keys.js";
import { Clock } from "../../web/view/movers.js";
import type { Live, Source } from "../../web/view/source.js";
import { Viewer } from "../../web/view/viewer.js";

export type FakeLive = { map: string; surface: string; on: (u: Live) => void; stopped: boolean };

export type Open = Map<string, { t: number; bytes: Uint8Array }>;

/**
 * A source over `files` (bytes as the source returns them, gunzipped; anything else as JSON), logging each request.
 * `gate` holds a request until its promise resolves.
 */
export function fakeSource(files: Map<string, unknown>, open?: Open, gate?: (key: string) => Promise<void>) {
	const requests: string[] = [];
	const lives: FakeLive[] = [];
	const source: Source = {
		async get(key) {
			requests.push(key);
			await gate?.(key);
			const v = files.get(key);
			if (v === undefined || v instanceof Uint8Array) {
				return v;
			}
			return new TextEncoder().encode(JSON.stringify(v));
		},
		icon: key => key,
		live(map, surface, _catalog, on) {
			const l = { map, surface, on, stopped: false };
			lives.push(l);
			return () => {
				l.stopped = true;
			};
		},
	};
	if (open) {
		source.open = async key => {
			requests.push(`open:${key}`);
			return open.get(key);
		};
	}
	return { source, requests, lives };
}

/** One map ("i-1") with one surface ("nauvis") and one force ("player"), its areas per level as given. */
export function catalog(areas: string[][], surface: Partial<Omit<SurfaceInfo, "forces">> = {}): Catalog {
	return {
		updated: 1_000_000, window_ms: 60_000, live_ms: 5000,
		maps: {
			"i-1": {
				title: "one", instances: {},
				surfaces: {
					nauvis: {
						first: 0, live: true, days: [], edges: [], ...surface,
						forces: { player: { tags: false, areas } },
					},
				},
			},
		},
	};
}

/** A viewer on a fake source, with a frame queue and a hand-driven performance clock. */
export function setup(files: Map<string, unknown>, open?: Open, gate?: (key: string) => Promise<void>, delay = 0) {
	const fake = fakeSource(files, open, gate);
	const queue: (() => void)[] = [];
	const perf = { now: 0 };
	let draws = 0;
	const viewer = new Viewer(fake.source, new Clock(() => perf.now), cb => queue.push(cb), () => {
		draws += 1;
	}, delay);
	viewer.resize(1920, 1080);
	/** Run the frames asked for so far; returns how many ran. */
	const run = () => queue.splice(0).map(cb => cb()).length;
	/** Let every load land and every frame it asks for run (real time: gunzip runs on the threadpool). */
	async function settle() {
		for (let i = 0; i < 200; i++) {
			await new Promise(resolve => setTimeout(resolve, 1));
			if (run() === 0 && viewer.loading === 0) {
				return;
			}
		}
		throw new Error("the viewer never settled");
	}
	return { ...fake, viewer, queue, perf, run, settle, draws: () => draws };
}
