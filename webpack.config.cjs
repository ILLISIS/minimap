"use strict";
const path = require("path");
const webpack = require("webpack");
const { merge } = require("webpack-merge");

const common = require("@clusterio/web_ui/webpack.common");

// The stub federated bundle (minimap plan A, ruling 2), as plugins/global_chat/webpack.config.cjs: the web UI reads the
// declaration and its config fields from "./". Plan D adds "./web" and the public viewer's second config (spec §5.1).
module.exports = (env = {}, argv = {}) => merge(common(env, argv), {
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
});
