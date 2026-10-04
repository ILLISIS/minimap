-- Terrain (spec §6.2, K1–K4): on_chunk_charted queues a chunk; on_tick reads two a tick and sends the changed ones.
-- The forces with players (M7), mm.surfaces and the resync's walk of charted chunks (§6.7) live here too.
local core = require("modules/minimap/capture_core")
local tick = require("modules/minimap/tick")
local overlays = require("modules/minimap/overlays")

local terrain = {}

-- ponytail: K2. `last` (each chunk key's last sent chart) is a file-local, not storage: it only decides whether a line
-- is printed, and printing changes no game state while no line takes Clusterio's file path, which tick.lua's cut
-- guarantees. A joining client starts empty, which changes only its own stdout, and the resync at every start refills
-- it. Keeping it out of the save keeps 2,048 bytes a chunk out: 512 KB per surface and force at T = 512. If it ever
-- gates game state, it moves to storage.
local last = {}

--- mm_rt.seam.chart's fn(force, surface, position) → chart or nil (§16.3), or nil for the engine. Headless servers
--- never chart (spike 11 P2), so the game tests and the E2E stand it in for get_chunk_chart and is_chunk_charted.
terrain.seam = nil

local function chart_of(force, surface, pos)
	if terrain.seam then
		return terrain.seam(force, surface, pos)
	end
	return force.get_chunk_chart(surface, pos)
end

local function is_charted(force, surface, pos)
	if terrain.seam then
		return terrain.seam(force, surface, pos) ~= nil
	end
	return force.is_chunk_charted(surface, pos)
end

--- M7: only forces with a player are captured. Read at install, and at every player creation, force change and
--- removal.
function terrain.refresh_forces()
	local st = storage.minimap
	if not st then
		return
	end
	local forces = {}
	for _, p in pairs(game.players) do
		forces[p.force.index] = true
	end
	st.forces = forces
end

--- §6.2's handler (≈ 1 µs): a captured chunk of a captured force, not already waiting, joins the queue; past the cap it
--- is dropped and counted (K4). A forced push skips the pending and cap checks (deletions, below).
function terrain.on_chunk_charted(e, forced)
	local st = storage.minimap
	if not (st and st.configured and st.forces[e.force.index]) then
		return
	end
	local p = e.position
	if not core.captured(st.tile, st.bounds, game.get_surface(e.surface_index).name, p.x, p.y) then
		return
	end
	local key = core.key(e.surface_index, e.force.index, p.x, p.y)
	if st.pending[key] and not forced then
		return
	end
	if core.push(st.queue, { si = e.surface_index, fi = e.force.index, x = p.x, y = p.y, forced = forced },
		not forced and core.CAP or nil) then
		st.pending[key] = true
	else
		st.drops = st.drops + 1
	end
end

--- §6.2 step 4: a deleted chunk is read again for each captured force, and its nil chart sends an mm.chunk without d.
--- Forced: `last` is empty after a load, and nil == nil would otherwise swallow a deletion the controller still needs.
function terrain.on_chunk_deleted(e)
	local st = storage.minimap
	if not (st and st.configured) then
		return
	end
	for _, p in pairs(e.positions) do
		for fi in pairs(st.forces) do
			terrain.on_chunk_charted({ surface_index = e.surface_index, force = game.forces[fi], position = p }, true)
		end
	end
end

--- §6.2 steps 1–4 for one queued item. A forced item (a resync's) is sent though unchanged (§6.7 step 4).
local function read(st, item)
	local key = core.key(item.si, item.fi, item.x, item.y)
	st.pending[key] = nil
	local force, surface = game.forces[item.fi], game.get_surface(item.si)
	if not (force and surface) then
		return -- plan ruling 11: a deleted surface's chunks are skipped here
	end
	local chart = chart_of(force, surface, { x = item.x, y = item.y })
	if item.forced then
		overlays.machines_in(st, surface, force, { x = item.x, y = item.y }) -- §6.7 step 5
	end
	if chart == last[key] and not item.forced then
		return
	end
	last[key] = chart
	tick.send{ type = "mm.chunk", s = surface.name, f = force.name, x = item.x, y = item.y,
		d = chart and helpers.encode_string(chart) or nil }
end

--- §6.10 step 2: up to core.CHARTS items a tick. The resync's sentinel marks its chunks done (control.lua's finish).
function terrain.take(st)
	for _ = 1, core.CHARTS do
		local item = core.pop(st.queue)
		if not item then
			return
		end
		if item.resynced then
			if st.resync and st.resync.trace == item.resynced then
				st.resync.done = true
			end
		else
			read(st, item)
		end
	end
end

--- §6.7 step 1: each surface's name and whether it is the tile's, at most core.SURFACES_MAX a message (plan ruling 9).
function terrain.surfaces(st)
	local list = {}
	for _, s in pairs(game.surfaces) do
		if #list == core.SURFACES_MAX then
			tick.send{ type = "mm.surfaces", list = list }
			list = {}
		end
		list[#list + 1] = { name = s.name, tile = st.tile ~= nil and s.name == st.tile.surface }
	end
	tick.send{ type = "mm.surfaces", list = list }
end

--- §6.7 step 4 (K33): every charted chunk of every captured force, pushed forced and past the cap, then the sentinel.
--- On the tile's surface that is a walk of the bounds; elsewhere a walk of get_chunks(), in this tick (≈ 3–8 ms for
--- 15,000 chunks, estimated). ponytail: one tick per start; a bounding box per surface is the upgrade (K33).
function terrain.resync(st)
	local r = st.resync
	for _, surface in pairs(game.surfaces) do
		local function push(x, y)
			for fi in pairs(st.forces) do
				local force = game.forces[fi]
				if force and is_charted(force, surface, { x = x, y = y }) then
					core.push(st.queue, { si = surface.index, fi = fi, x = x, y = y, forced = true })
					st.pending[core.key(surface.index, fi, x, y)] = true
					r.chunks = r.chunks + 1
				end
			end
		end
		if st.tile and surface.name == st.tile.surface then
			local b = st.bounds
			for x = b.x1, b.x2 - 1 do
				for y = b.y1, b.y2 - 1 do
					push(x, y)
				end
			end
		else
			for c in surface.get_chunks() do
				push(c.x, c.y)
			end
		end
	end
	core.push(st.queue, { resynced = r.trace })
end

return terrain
