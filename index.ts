import type * as lib from "@clusterio/lib";
import { MinimapDataEvent, MinimapLiveEvent } from "./messages.js";

declare module "@clusterio/lib" {
	export interface ControllerConfigFields {
		"minimap.window_seconds": number;
		"minimap.s3_endpoint": string | null;
		"minimap.s3_bucket": string | null;
		"minimap.s3_access_key_id": string | null;
		"minimap.s3_secret_access_key": string | null;
		"minimap.s3_region": string;
	}
	export interface Permissions {
		"minimap.view": never;
	}
}

/** K27: W is at least a minute; anything shorter would need parallel PUTs. */
export const MIN_WINDOW_SECONDS = 60;

export const plugin: lib.PluginDeclaration = {
	name: "minimap",
	title: "Minimap",
	description: "One map of the cluster from the game's own chart: terrain, trains, vehicles, players, tags and " +
		"recipes, live and through time (v2).",
	controllerEntrypoint: "dist/node/controller.js",
	instanceEntrypoint: "dist/node/instance.js",
	features: ["SavePatching", "ScriptCommands"],
	// §10.1. S3 storage is off unless the endpoint, the bucket and both keys are set.
	controllerConfigFields: {
		"minimap.window_seconds": {
			title: "Window (seconds)",
			description: "How often the map's files are written and pushed to S3 storage. At least 60; a change " +
				"applies from the next window.",
			type: "number",
			initialValue: 300,
			validator: (value: number) => {
				if (value < MIN_WINDOW_SECONDS) {
					throw new Error(`minimap.window_seconds must be at least ${MIN_WINDOW_SECONDS}`);
				}
			},
		},
		"minimap.s3_endpoint": {
			title: "S3 storage endpoint",
			description: "e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com. Unset: no public copy.",
			type: "string",
			optional: true,
		},
		"minimap.s3_bucket": {
			title: "S3 storage bucket",
			type: "string",
			optional: true,
		},
		"minimap.s3_access_key_id": {
			title: "S3 storage access key id",
			type: "string",
			optional: true,
			credential: ["controller"],
		},
		"minimap.s3_secret_access_key": {
			title: "S3 storage secret access key",
			type: "string",
			optional: true,
			credential: ["controller"],
		},
		"minimap.s3_region": {
			title: "S3 storage region",
			description: "auto for Cloudflare R2.",
			type: "string",
			initialValue: "auto",
		},
	},
	messages: [MinimapDataEvent, MinimapLiveEvent],
	permissions: [
		{
			name: "minimap.view",
			title: "View the minimap",
			description: "See the minimap page, its files and its live updates.",
			grantByDefault: true,
		},
	],
	webEntrypoint: "./web",
	routes: ["/minimap"],
};
