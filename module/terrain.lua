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

--- M7: only forces with a player are captured. Read at install, at every config, and at every player creation, force
--- change, removal and merge.
function terrain.refresh_forces()
	local st = storage.minimap
	if not st then
		return
	end
	local forces = {}
	for _, p in pairs(game.players) do
		forces[p.force.index] = true
	end
	for index in pairs(st.seam_forces or {}) do
		if game.forces[index] then
			forces[index] = true
		end
	end
	st.forces = forces
end

--- Deleted surface indexes can be reused, so the new surface must not inherit the old one's last-sent charts. `last`
--- only gates printing (K2), so clearing it is desync-safe.
function terrain.on_surface_deleted(e)
	local st = storage.minimap
	if st and st.boxes then
		st.boxes[e.surface_index] = nil
	end
	local prefix = e.surface_index .. ":"
	for key in pairs(last) do
		if key:sub(1, #prefix) == prefix then
			last[key] = nil
		end
	end
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

--- §6.10 step 3: up to core.CHARTS items a tick. The resync's sentinel marks its chunks done (control.lua's finish).
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

--- K33's upgrade: each surface's rows of generated chunks, in `ys` (the order they appeared) and `rows` (y → its x
--- extent, half-open like core.bounds), so the resync walks them a slice a tick instead of get_chunks() in one (owner,
--- 2026-10-05: one 90-ms tick for 15,129 chunks in the bench). Rows, not one box, and only the rows that exist: chunks
--- far apart (UE's test edges are 95,000 tiles out) would make a box of millions of positions. A row's extent spans its
--- gaps, and a deleted chunk stays in it: the walk reads those as uncharted, so its length follows the rows' spans, not
--- the chunk count.
local function grow(boxes, si, x, y)
	local b = boxes[si]
	if not b then
		b = { ys = {}, rows = {} }
		boxes[si] = b
	end
	local row = b.rows[y]
	if row then
		row[1], row[2] = math.min(row[1], x), math.max(row[2], x + 1)
	else
		b.rows[y] = { x, x + 1 }
		b.ys[#b.ys + 1] = y
	end
end

--- The rows from get_chunks(): for a new storage and at every on_server_startup (control.lua), so chunks generated while
--- the plugin was off are walked too; on_chunk_generated grows them in between.
function terrain.boxes()
	local boxes = {}
	for _, s in pairs(game.surfaces) do
		for c in s.get_chunks() do
			grow(boxes, s.index, c.x, c.y)
		end
	end
	return boxes
end

function terrain.on_chunk_generated(e)
	local st = storage.minimap
	if st and st.boxes then
		grow(st.boxes, e.surface.index, e.position.x, e.position.y)
	end
end

--- §6.7 step 4 (K33): every charted chunk of every captured force, pushed forced and past the cap, then the sentinel.
--- This starts the walk; terrain.walk does it over the next ticks, surface by surface.
function terrain.resync(st)
	local list = {}
	for _, s in pairs(game.surfaces) do
		list[#list + 1] = s.index
	end
	st.resync.walk = { list = list, k = 0 }
end

--- A surface to walk and its area: the tile's bounds on its surface, else its rows of generated chunks.
local function area(st, si)
	local s = si and game.get_surface(si)
	if s and st.tile and s.name == st.tile.surface then
		return s, st.bounds
	end
	return s, s and st.boxes[si]
end

--- Row i of an area: its y and x extent (half-open), or nil past the last. The bounds' rows are its y1 .. y2 - 1.
local function row(b, i)
	if not b.ys then
		local y = b.y1 + i - 1
		if y < b.y2 then
			return y, b.x1, b.x2
		end
		return nil
	end
	local y = b.ys[i]
	if y then
		local r = b.rows[y]
		return y, r[1], r[2]
	end
end

--- §6.10 step 2: the resync's walk, at most core.RESYNC_READS positions read a tick, stopping once core.RESYNC_CHUNKS
--- charted chunks are queued; the sentinel follows the last surface's last row.
function terrain.walk(st)
	local r = st.resync
	local w = r and r.walk
	if not w then
		return
	end
	local s, b = area(st, w.list[w.k])
	local reads, pushed = 0, 0
	while reads < core.RESYNC_READS and pushed < core.RESYNC_CHUNKS do
		local y, x1, x2
		if s and b then
			y, x1, x2 = row(b, w.i)
		end
		if not y then -- this surface is done, gone or empty: the next one
			w.k = w.k + 1
			if w.k > #w.list then
				core.push(st.queue, { resynced = r.trace })
				r.walk = nil
				return
			end
			s, b = area(st, w.list[w.k])
			w.i, w.x = 1, nil
		else
			local x = w.x or x1
			if x >= x2 then -- this row is done: the next
				w.i, w.x = w.i + 1, nil
			else
				reads = reads + 1
				local pos = { x = x, y = y }
				for fi in pairs(st.forces) do
					local force = game.forces[fi]
					if force and is_charted(force, s, pos) then
						core.push(st.queue, { si = s.index, fi = fi, x = x, y = y, forced = true })
						st.pending[core.key(s.index, fi, x, y)] = true
						r.chunks, pushed = r.chunks + 1, pushed + 1
					end
				end
				w.x = x + 1
			end
		end
	end
end
return terrain
