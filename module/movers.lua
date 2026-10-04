-- Movers (spec §6.3, §13; K6, K7, K28–K30): a scan of what moves, a walk polling core.WALK a tick, samples by dead
-- reckoning, journeys minted by the scan and followed through joins and splits, and with UE adopted across crossings.
local clusterio_api = require("modules/clusterio/api")
local core = require("modules/minimap/capture_core")
local tick = require("modules/minimap/tick")

local movers = {}

--- A train's or vehicle's registration for on_object_destroyed: its number only. LuaTrain is a registration target,
--- its useful_id the train id ([api] RegistrationTarget).
local function register(ref)
	return (script.register_on_object_destroyed(ref))
end

local vehicle_names
--- §6.3: every car and spider-vehicle prototype name; get_vehicles without `type` returns rolling stock too
--- (spike 11 P4). ponytail: a file-local cache of a pure function of the prototypes, the same on every client.
local function vehicles()
	if not vehicle_names then
		vehicle_names = {}
		for name in pairs(prototypes.get_entity_filtered{ { filter = "type", type = { "car", "spider-vehicle" } } }) do
			vehicle_names[#vehicle_names + 1] = name
		end
	end
	return vehicle_names
end

--- The connected players. The game tests replace it to walk a player that has no character (C9): headless has none.
function movers.players()
	return game.connected_players
end

--- K7: a new journey for train or vehicle `key`, registered.
local function mint(st, ref, kind, key, t)
	local j = core.mint(clusterio_api.get_instance_id(), t, key, kind)
	core.take(st, j, kind, key, ref, kind == "t" and #ref.carriages or nil, register)
	return j
end

--- §6.3: journey j's gone, if it was ever sampled, then forget it.
function movers.gone(st, j)
	local m = st.movers[j]
	if not m then
		return
	end
	if m.s then
		tick.move(m.s, { j = j, gone = true })
	end
	core.forget(st, j)
end

--- One poll of journey j (§6.3): a train reads its leading end (K30), a vehicle its position, a player its physical
--- controller. A handle gone invalid without its event (a missed join, a deleted surface) ends the journey (plan
--- ruling 12). Returns true when it sent a sample.
local function poll(st, j, t, how)
	local m = st.movers[j]
	if not m then
		return false
	end
	local r = m.ref
	-- a loaded save can hold a player who is no longer connected, and no on_player_left_game is raised for them
	if not (r and r.valid) or (m.kind == "p" and not r.connected) then
		movers.gone(st, j)
		return false
	end
	local e, pos, si
	if m.kind == "t" then
		e = r.speed >= 0 and r.front_stock or r.back_stock
		pos, si = e.position, e.surface_index
	elseif m.kind == "v" then
		e, pos, si = r, r.position, r.surface_index
	else
		pos, si = r.physical_position, r.physical_surface_index
	end
	if not core.poll(m, pos.x, pos.y, si, t, how) then
		return false
	end
	m.s = game.get_surface(si).name
	local src = e or r
	-- plan ruling 8: n rides on every train sample
	tick.move(m.s, { j = j, k = m.kind, f = src.force.name, name = src.name, x = pos.x, y = pos.y, vx = m.vx,
		vy = m.vy, n = m.n })
	return true
end

--- §6.3's scan: what moves now, minting a journey for each moving train and vehicle without one. A mover of the last
--- walk that isn't in this one has stopped: one read, and a sample at zero velocity.
local function scan(st, t)
	local walk, seen = {}, {}
	local function add(j)
		if not seen[j] then
			seen[j] = true
			walk[#walk + 1] = j
		end
	end
	for _, tr in pairs(game.train_manager.get_trains{ is_moving = true }) do
		add(st.by_train[tr.id] or mint(st, tr, "t", tr.id, t))
	end
	for _, v in pairs(game.get_vehicles{ is_moving = true, type = vehicles() }) do
		add(st.by_unit[v.unit_number] or mint(st, v, "v", v.unit_number, t))
	end
	for _, p in pairs(movers.players()) do
		local j = "p:" .. p.name
		st.movers[j] = st.movers[j] or { kind = "p" }
		st.movers[j].ref = p
		add(j)
	end
	for _, j in ipairs(st.walk) do
		if not seen[j] then
			poll(st, j, t, "stop")
		end
	end
	st.walk, st.wi, st.next_scan = walk, 1, t + core.SCAN
end

--- §6.10 step 4: poll up to core.WALK movers; with the walk done and core.SCAN ticks passed, scan instead.
function movers.step(st, t)
	if st.wi > #st.walk then
		if t >= st.next_scan then
			scan(st, t)
		end
		return
	end
	for _ = 1, core.WALK do
		local j = st.walk[st.wi]
		if not j then
			return
		end
		st.wi = st.wi + 1
		poll(st, j, t)
	end
end

--- §6.3's seeding, at the first config (plan ruling 5): every train and vehicle gets a journey, so a parked one is
--- known to the resync.
function movers.seed(st, t)
	for _, tr in pairs(game.train_manager.get_trains{}) do
		if not st.by_train[tr.id] then
			mint(st, tr, "t", tr.id, t)
		end
	end
	for _, v in pairs(game.get_vehicles{ type = vehicles() }) do
		if not st.by_unit[v.unit_number] then
			mint(st, v, "v", v.unit_number, t)
		end
	end
	st.seeded = true
end

--- §6.7 step 2: a sample for every known mover, parked ones included (≈ 1 µs each).
function movers.resync(st, t)
	for j in pairs(st.movers) do
		if poll(st, j, t, "force") then
			st.resync.movers = st.resync.movers + 1
		end
	end
end

--- K29: the new train takes old_train_id_1's journey, else old_train_id_2's; the other of two ends with gone.
function movers.on_train_created(e)
	local st = storage.minimap
	if not st then
		return
	end
	local tr = e.train
	local ended = core.train_created(st, e.old_train_id_1, e.old_train_id_2, tr.id, tr, #tr.carriages, register)
	if ended then
		movers.gone(st, ended)
	end
end

--- §13 source (ue.transfers.extend's capture): the crossing carries the journey. It reads storage only, so a replayed
--- capture is identical (UE's D21).
function movers.capture(ep, h)
	local st = storage.minimap
	if not st then
		return nil
	end
	local j
	if ep.type == "train" then
		j = st.by_train[h.id]
	else
		j = st.by_unit[h.unit_number]
	end
	return j and { j = j } or nil
end

--- §13 destination (materialized): take the source's journey over any entry, and tell the controller, which from then
--- on accepts j only from this instance (K28). Logged under the crossing's trace, which UE's ue.transfer lines carry.
function movers.materialized(ep, h, data, meta)
	local st = storage.minimap
	if not (st and type(data) == "table" and type(data.j) == "string") then
		return
	end
	local displaced
	if ep.type == "train" then
		displaced = core.adopt(st, data.j, "t", h.id, h, #h.carriages, register)
	else
		displaced = core.adopt(st, data.j, "v", h.unit_number, h, nil, register)
	end
	if displaced then
		movers.gone(st, displaced) -- plan ruling 30
	end
	tick.send{ type = "mm.adopt", j = data.j, trace = meta.trace }
	tick.send{ type = "trace", op = "minimap.journey", phase = "adopted", level = "verbose", trace = meta.trace,
		journey = data.j, edge = ep.edge, cid = ep.cid }
end

return movers
