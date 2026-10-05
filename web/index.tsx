import React from "react";
import * as lib from "@clusterio/lib";
import type { WebPluginContext } from "@clusterio/web_ui";
import { MinimapLiveEvent } from "../messages.js";
import { apiSource, type Live } from "./view/source.js";
// No extension: webpack.common maps .js to .ts, not .tsx (packages/web_ui/webpack.common.js).
import MinimapPage from "./MinimapPage";

/** The web entry point, as UE's (universal_edges/web/index.tsx): the Clusterio page at /minimap (spec §11.1). */
export default async function loadWebPlugin(context: WebPluginContext) {
	const { control, plugin } = context;
	// One subscriber for the page's life: its constructor registers the event's handler on the link.
	let current: ((u: Live) => void) | undefined;
	const live = new lib.EventSubscriber(MinimapLiveEvent, control, event => {
		if (event) {
			current?.(event);
		}
	});
	// §9.2: one filter, "<map>|<surface>", at a time; on subscribe the controller replays that surface's movers.
	const source = apiSource(webRoot, () => control.connector.token ?? "", (map, surface, _catalog, on) => {
		const filter = `${map}|${surface}`;
		current = on;
		live.addFilters(filter);
		return () => {
			current = undefined;
			live.removeFilters(filter);
		};
	});
	control.hooks.pages.attach(plugin.name, () => [
		{
			path: "/minimap",
			sidebarName: "Minimap",
			// Client side only: the routes and the subscription check minimap.view themselves (§9).
			permission: "minimap.view",
			content: <MinimapPage source={source} />,
		},
	]);
}
