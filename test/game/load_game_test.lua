local t = require("modules/v2_test/testlib")
local control = require("modules/minimap/control")
local mt = require("modules/v2_test/minimap")

-- Minimap spec §16.3 "Load", in both passes: plugins (ue_rt defined) and standalone (no UE, no GW).
t.case("minimap: the module loads in both passes; UE's API is found exactly when UE is patched in (§12.1)", function(ctx)
	ctx.at(1, function()
		ctx.expect(type(mm_rt) == "table", "mm_rt is defined")
		ctx.expect((control.ue ~= nil) == (ue_rt ~= nil), "control.ue is set iff UE's runtime is loaded")
		ctx.expect(control.ue == nil or control.ue.api_version == 1, "UE's api_version is 1")
	end)
end)

t.case("minimap.integration: gridworld at a tile config, universal_edges exactly when UE is loaded (§12.1, §14)",
	function(ctx)
		ctx.at(20, function()
			mt.config()
		end)
		ctx.at(25, function()
			local phases = {}
			for _, m in ipairs(mt.msgs("trace", 0, game.tick, function(m) return m.op == "minimap.integration" end)) do
				phases[m.phase] = true
				ctx.expect(m.level == "info", "logged at info")
			end
			ctx.expect(phases.gridworld == true, "gridworld, for the tile config")
			ctx.expect((phases.universal_edges == true) == (ue_rt ~= nil), "universal_edges exactly when UE is loaded")
		end)
	end)
