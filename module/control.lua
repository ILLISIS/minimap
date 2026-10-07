-- Minimap v2 module entry (spec §6): the handlers, the per-tick steps (§6.10), and the config and resync behind mm_rt
-- (§6.1, §6.7). It depends only on Clusterio (M10); UE is optional (§12.1).
local clusterio_api = require("modules/clusterio/api")
local core = require("modules/minimap/capture_core")
local tick = require("modules/minimap/tick")
local terrain = require("modules/minimap/terrain")
local movers = require("modules/minimap/movers")
local overlays = require("modules/minimap/overlays")

local control = { events = {} }

-- §12.1: UE's Lua API when its module is patched in (clusterio/packages/host/src/patch.ts:49-52), nil standalone.
-- A missing module fails the require, and pcall keeps that from failing the load.
local ok, ue = pcall(require, "modules/universal_edges")
control.ue = ok and type(ue) == "table" and ue.api_version == 1 and ue or nil
-- §13, K28: with UE, a crossing train or vehicle carries its journey; no UE change is needed (spike 11 P8).
if control.ue then
	control.ue.transfers.extend{ name = "minimap", types = { train = true, vehicle = true }, capture = movers.capture,
		materialized = movers.materialized }
end

--- storage.minimap, created or brought to this code's schema (§6.8); a new one reads which forces have players.
local function ensure()
	local fresh = storage.minimap == nil
	storage.minimap = core.migrate(storage.minimap or {})
	if fresh then
		terrain.refresh_forces()
	end
	storage.minimap.boxes = storage.minimap.boxes or terrain.boxes() -- K33: a new storage, and every boot (below)
	return storage.minimap
end

local function int(v)
	return type(v) == "number" and v == math.floor(v)
end

--- A tile's exclude list (gridworld/world/contracts.ts:16-17): absent, or planet names.
local function names(v)
	if v == nil then
		return true
	end
	if type(v) ~= "table" then
		return false
	end
	for _, name in pairs(v) do
		if type(name) ~= "string" then
			return false
		end
	end
	return true
end

--- mm_rt.config(json) (§6.1, §7.2): { tile? }, tile being gridworld.tile's { world, x, y, size, surface, … }. Capture
--- starts here, once per boot. Every field Lua reads is checked; a bad one raises, and RCON returns the error.
function control.config(json)
	local c = helpers.json_to_table(json)
	assert(type(c) == "table", "minimap config: not a JSON object: " .. tostring(json))
	local tile = c.tile
	assert(tile == nil or (type(tile) == "table" and type(tile.world) == "string" and type(tile.surface) == "string"
		and int(tile.x) and int(tile.y) and int(tile.size) and tile.size > 0 and tile.size % 64 == 0 and names(tile.exclude)),
		"minimap config: bad tile: " .. tostring(json))
	local st = ensure()
	terrain.refresh_forces() -- players may have joined while the plugin was off, or forces merged
	st.tile, st.bounds, st.configured = tile, core.bounds(tile), true
	if not st.seeded then
		movers.seed(st, game.tick) -- plan ruling 5: by the first config the instance id is set (K7)
	end
	-- §14: the integrations found, at each config (plan ruling 15)
	if control.ue then
		tick.send{ type = "trace", op = "minimap.integration", phase = "universal_edges", level = "info" }
	end
	if tile then
		tick.send{ type = "trace", op = "minimap.integration", phase = "gridworld", level = "info", world = tile.world,
			surface = tile.surface }
	end
end

--- mm_rt.resync(trace) (§6.7, K5, K33): the surfaces, then every charted captured chunk over the next ticks, forced
--- past the compare and the cap; mm.resynced follows the last of them. A newer resync replaces one still running (plan ruling 16).
function control.resync(trace)
	assert(type(trace) == "string", "minimap resync: the trace must be a string")
	local st = ensure()
	st.resync = { trace = trace, chunks = 0, movers = 0, tags = 0, machines = 0 }
	terrain.surfaces(st)
	movers.resync(st, game.tick)
	overlays.resync_tags(st)
	terrain.resync(st)
end

--- §6.7 step 6: once the resync's sentinel is taken and no machine waits, mm.resynced with its counts.
local function finish(st)
	local r = st.resync
	if r and r.done and core.size(st.machines) == 0 then
		tick.send{ type = "mm.resynced", trace = r.trace, counts = { chunks = r.chunks, movers = r.movers,
			tags = r.tags, machines = r.machines, drops = st.drops + tick.oversize() } }
		st.resync = nil
	end
end

--- §6.10: nothing before this boot's config; then the chart items, the resync's end, and the flush.
control.events[defines.events.on_tick] = function(e)
	local st = storage.minimap
	if not (st and st.configured) then
		return
	end
	terrain.walk(st)
	terrain.take(st)
	overlays.step(st)
	movers.step(st, e.tick)
	finish(st)
	tick.flush(e.tick)
end

control.on_init = ensure
control.on_configuration_changed = ensure
-- §6.1: a start, crash or rollback. Nothing is captured until the instance plugin configures this boot.
control.events[clusterio_api.events.on_server_startup] = function()
	-- K33: ensure() rebuilds the rows at boot, so chunks generated while the plugin was off are walked too
	if storage.minimap then
		storage.minimap.boxes = nil
	end
	local st = ensure()
	st.configured = false
	-- §22.4: no step runs until the config, so the wheel's due ticks would pass unread; the scan finds the trains again
	st.wheel, st.fast = {}, {}
end
control.events[defines.events.on_chunk_charted] = terrain.on_chunk_charted
control.events[defines.events.on_chunk_deleted] = terrain.on_chunk_deleted
control.events[defines.events.on_chunk_generated] = terrain.on_chunk_generated
control.events[defines.events.on_surface_created] = terrain.on_surface_created
control.events[defines.events.on_surface_deleted] = terrain.on_surface_deleted
for _, name in ipairs({ "on_player_created", "on_player_changed_force", "on_player_removed", "on_forces_merged" }) do
	control.events[defines.events[name]] = terrain.refresh_forces
end

-- §6.3, §13, K29: journeys follow joins and splits; a registered train or vehicle ends with gone, as does a player who
-- leaves. These follow the save's state, so they run before the config too (plan ruling 10).
control.events[defines.events.on_train_created] = movers.on_train_created
control.events[defines.events.on_object_destroyed] = function(e)
	local st = storage.minimap
	local v = st and st.reg[e.registration_number]
	if v == nil then
		return
	end
	st.reg[e.registration_number] = nil
	if type(v) == "string" then
		movers.gone(st, v)
	else
		overlays.removed(v)
	end
end
control.events[defines.events.on_player_left_game] = function(e)
	local st, p = storage.minimap, game.get_player(e.player_index)
	if st and p then
		movers.gone(st, "p:" .. p.name)
	end
end

-- §6.4: chart tags. §6.6: v1's recipe hooks (M7); circuit-set recipes and a furnace's own switch are missed (K17).
for _, name in ipairs({ "on_chart_tag_added", "on_chart_tag_modified", "on_chart_tag_removed" }) do
	control.events[defines.events[name]] = overlays.on_tag
end
for _, name in ipairs({ "on_built_entity", "on_robot_built_entity", "on_space_platform_built_entity",
	"script_raised_built", "script_raised_revive", "on_entity_settings_pasted", "on_gui_closed" }) do
	control.events[defines.events[name]] = overlays.on_entity
end

return control
