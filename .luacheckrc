-- "pure" Lua runs on plain Lua 5.2 (unit tests); everything under module/ and test/game/ runs inside Factorio.
std = "lua52"
max_line_length = 140
exclude_files = { "**/node_modules/**", "**/dist/**" }
stds.factorio = {
	-- storage is the one Factorio global our code writes: each plugin owns storage[<plugin name>].
	globals = { "storage" },
	read_globals = {
		"game", "script", "defines", "helpers", "prototypes", "settings", "remote",
		"commands", "rendering", "rcon", "log", "serpent", "table_size", "localised_print",
		"clusterio_private",
	},
}
files["**/module/**/*.lua"] = { std = "lua52+factorio" }
files["**/module/**/*_core.lua"] = { std = "lua52" }
files["**/test/game/**/*.lua"] = { std = "lua52+factorio", read_globals = { "ue_rt" } }
-- The minimap's RCON entry point (minimap spec §7.2) is the one global its module defines; its game tests read it.
files["module/globals.lua"] = { globals = { "mm_rt" } }
files["test/game/**/*.lua"] = { read_globals = { "mm_rt" } }
