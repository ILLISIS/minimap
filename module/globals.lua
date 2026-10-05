-- The minimap's RCON entry point (spec §7.2) and its terrain seams (§16.3). Headless servers never chart (spike 11 P2),
-- so the game tests and Plan B's E2E stand the engine in through mm_rt.seam (plan ruling 14).
local control = require("modules/minimap/control")
local terrain = require("modules/minimap/terrain")

mm_rt = {
	--- /sc mm_rt.config("<json { tile? }>"): at every start, on a gridworld.tile change and on reconnect (§6.1).
	config = control.config,
	--- /sc mm_rt.resync("<trace>"): right after the config, at the same moments (§6.7).
	resync = control.resync,
	seam = {
		--- mm_rt.seam.chart(fn): fn(force, surface, { x, y }) → a 2,048-byte chart or nil stands in for get_chunk_chart
		--- and is_chunk_charted (charted = a string). nil restores the engine.
		chart = function(fn)
			terrain.seam = fn
		end,
		--- mm_rt.seam.charted("<surface>", "<force>", cx, cy): on_chunk_charted for that chunk.
		charted = function(surface, force, cx, cy)
			terrain.on_chunk_charted{ surface_index = game.get_surface(surface).index, force = game.forces[force],
				position = { x = cx, y = cy } }
		end,
		--- mm_rt.seam.force("<force>"): capture that force as if it had a player (M7; headless has none).
		force = function(name)
			local st, index = storage.minimap, game.forces[name].index
			-- ponytail: test-only (headless servers have no players); kept in storage so a config's refresh_forces keeps it
			st.seam_forces = st.seam_forces or {}
			st.seam_forces[index] = true
			st.forces[index] = true
		end,
	},
}
