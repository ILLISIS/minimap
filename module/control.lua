-- Minimap v2 module entry (spec §6). It depends only on Clusterio (M10); UE is optional (§12.1).
local control = { events = {} }

-- §12.1: UE's Lua API when its module is patched in (clusterio/packages/host/src/patch.ts:49-52), nil standalone.
-- A missing module fails the require, and pcall keeps that from failing the load.
local ok, ue = pcall(require, "modules/universal_edges")
control.ue = ok and type(ue) == "table" and ue.api_version == 1 and ue or nil

return control
