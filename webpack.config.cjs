"use strict";
const path = require("path");
const webpack = require("webpack");
const { customizeArray, merge, mergeWithCustomize } = require("webpack-merge");

const common = require("@clusterio/web_ui/webpack.common");

// Two bundles (spec §5.1): the federated plugin bundle for the web UI, as UE's (universal_edges/webpack.config.cjs),
// and the public page's viewer, one file that Plan C uploads as viewer-<sha8>.js (§10.8).
module.exports = (env = {}, argv = {}) => [
	merge(common(env, argv), {
		name: "plugin",
		context: __dirname,
		entry: "./web/index.tsx",
		output: {
			path: path.resolve(__dirname, "dist", "web"),
		},
		plugins: [
			new webpack.container.ModuleFederationPlugin({
				name: "minimap",
				library: { type: "var", name: "plugin_minimap" },
				exposes: {
					"./": "./index.ts",
					"./package.json": "./package.json",
					"./web": "./web/index.tsx",
				},
				shared: {
					"@clusterio/lib": { import: false },
					"@clusterio/web_ui": { import: false },
					"antd": { import: false },
					"react": { import: false },
					"react-dom": { import: false },
				},
			}),
		],
	}),
	// One self-contained file and nothing else (the controller's pin): none of common's plugins (the manifest,
	// the polyfills the web UI needs), no source map, no split chunks; output.clean empties dist/public first.
	mergeWithCustomize({ customizeArray: customizeArray({ plugins: "replace" }) })(common(env, argv), {
		name: "viewer",
		context: __dirname,
		entry: "./web/public.ts",
		devtool: false,
		plugins: [],
		optimization: { splitChunks: false },
		output: {
			path: path.resolve(__dirname, "dist", "public"),
			filename: "viewer.js",
			clean: true,
		},
	}),
];
