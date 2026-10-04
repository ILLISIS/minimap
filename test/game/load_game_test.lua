local t = require("modules/v2_test/testlib")
local control = require("modules/minimap/control")

-- Minimap spec §16.3 "Load", in both passes: plugins (ue_rt defined) and standalone (no UE, no GW).
t.case("minimap: the module loads in both passes; UE's API is found exactly when UE is patched in (§12.1)", function(ctx)
	ctx.at(1, function()
		ctx.expect(type(mm_rt) == "table", "mm_rt is defined")
		ctx.expect((control.ue ~= nil) == (ue_rt ~= nil), "control.ue is set iff UE's runtime is loaded")
		ctx.expect(control.ue == nil or control.ue.api_version == 1, "UE's api_version is 1")
	end)
end)
