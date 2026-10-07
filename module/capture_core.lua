-- Pure rules of the minimap's capture (spec §6, §13; K4, K6, K7, K29, K34): the tile's bounds and the clip, chunk keys,
-- the capped FIFO, dead reckoning, journeys, the byte-exact cut and the storage migrations. State comes in as
-- arguments and no Factorio global is touched, so lua5.2 runs the tests (spec §16.1).
local core = {}

core.CAP = 20000 -- K4: event pushes past this many waiting are dropped and counted; resync pushes are exempt
core.CHARTS = 2 -- K4: chart items taken a tick
core.MACHINES = 8 -- K33: resync machines sent a tick
core.RESYNC_READS = 256 -- K33: chunk positions the resync's walk reads a tick (is_chunk_charted)
core.RESYNC_CHUNKS = 16 -- K33: the walk stops for the tick once this many charted chunks are queued (its last position
-- finishes its forces, so a tick can queue up to 15 + the captured forces)
core.WALK = 8 -- K6: movers polled a tick
core.SCAN = 30 -- K6: ticks at least from one scan to the next
core.EPS = 1 -- K6: tiles off the prediction, on either axis, before a sample (vehicles and players)
core.TRAIN_EPS = 0.5 -- §22.2: a train's, so its drawn path stays within half a tile of its rails
core.STEP = 4 -- plan G: tiles a moving train goes between reads
core.WHEEL = 32 -- plan G: slots of the wheel of due reads; more than core.SCAN, so a slot is never two laps ahead
core.FAST = 32 -- plan G: train reads a tick at most
core.HEARTBEAT = 600 -- K6: ticks from a mover's sample to its next, on its prediction
core.LIMIT = 3500 -- K34: bytes a printed line stays under
core.MOVE_MAX = 3 -- samples an mm.move carries: ≤ 2,523 bytes with 200-byte names (plan ruling 9)
core.SURFACES_MAX = 13 -- surfaces an mm.surfaces carries: ≤ 2,956 bytes with 200-byte names (plan ruling 9)
core.KINDS_MAX = 200 -- §22.2: a train's carriage kinds sent: three samples of 200 kinds and 200-byte names stay
-- under a line (plan F ruling P11)

--- The tile's chunks [x1, x2) × [y1, y2) (§6.1; gridworld/world/grid.ts:14), or nil without a tile. The config check
--- (control.config) makes size a multiple of 64, so T/2 is a whole number of chunks.
function core.bounds(tile)
	if not tile then
		return nil
	end
	local c, h = tile.size / 32, tile.size / 64
	return { x1 = tile.x * c - h, y1 = tile.y * c - h, x2 = tile.x * c + h, y2 = tile.y * c + h }
end

--- §22.1 (M14): whether the surface named `surface`, on planet `planet` (its LuaPlanet's name, or nil), is one of the
--- tile's: tile.surface always; any other only when it is a planet the world's exclude list doesn't name, as gridworld
--- tiles them (gridworld/module/tile.lua:153-158; plan F ruling P5). Without a tile, none is.
function core.tiled(tile, surface, planet)
	if not tile then
		return false
	end
	if surface == tile.surface then
		return true
	end
	if planet == nil then
		return false
	end
	for _, name in pairs(tile.exclude or {}) do
		if name == planet then
			return false
		end
	end
	return true
end

--- K3, §22.1: whether chunk (cx, cy) of the surface named `surface` (on `planet`, or nil) is captured: on a tiled
--- surface only inside the tile's bounds; every other surface, and every surface without a tile, whole.
function core.captured(tile, b, surface, cx, cy, planet)
	if not core.tiled(tile, surface, planet) then
		return true
	end
	return cx >= b.x1 and cx < b.x2 and cy >= b.y1 and cy < b.y2
end

--- A LuaSurface's planet name, or nil (a platform's, a lab's): core.tiled's and core.captured's last argument.
function core.planet(s)
	return s.planet and s.planet.name
end

--- A chunk's key (§6.2): per surface and force index, so equal coordinates on two surfaces never collide (C6).
function core.key(si, fi, x, y)
	return si .. ":" .. fi .. ":" .. x .. "," .. y
end

--- A FIFO in storage (§5.4): items at [head, tail].
function core.queue()
	return { head = 1, tail = 0 }
end

function core.size(q)
	return q.tail - q.head + 1
end

--- Append item. With cap, refuse it (false) once cap items wait; the caller counts the drop (K4).
function core.push(q, item, cap)
	if cap and core.size(q) >= cap then
		return false
	end
	q.tail = q.tail + 1
	q[q.tail] = item
	return true
end

function core.pop(q)
	if q.head > q.tail then
		return nil
	end
	local item = q[q.head]
	q[q.head] = nil
	q.head = q.head + 1
	if q.head > q.tail then
		q.head, q.tail = 1, 0
	end
	return item
end

--- K30: whether a train leads with its front. It runs towards its front while speed > 0, its back while < 0, and keeps
--- the end it last led with (`prev`, nil before any) while stopped; the front to begin with.
function core.forward(prev, speed)
	if speed ~= 0 then
		return speed > 0
	end
	return prev ~= false
end

--- Plan G: ticks until a train at `speed` (tiles a tick, ≠ 0) is read again: core.STEP tiles on, within [1, core.SCAN].
function core.next_read(speed)
	return math.min(core.SCAN, math.max(1, math.ceil(core.STEP / math.abs(speed))))
end

local function round3(v)
	return (math.floor(v * 1000 + 0.5) / 1000) % 1
end

--- §22.2: a train's leading end's heading as a Factorio orientation (0 north, 0.25 east, 3 decimals): from its second
--- carriage's position (sx, sy) towards the leading one's (x, y); with no second carriage (a one-carriage train), the
--- carriage's own `orientation`, half a turn on when it leads with its back (`back`).
function core.heading(x, y, sx, sy, orientation, back)
	if sx then
		return round3(math.atan2(x - sx, sy - y) / (2 * math.pi))
	end
	return round3(orientation + (back and 0.5 or 0))
end

--- One poll of mover m at (x, y) on surface index si (§6.3, K6). Returns true when a sample is due; m.x, m.y, m.vx, m.vy,
--- m.t and m.si then hold it. The velocity is the finite difference since the last poll, in tiles a second, and 0 across
--- a surface change. A first poll only records, so a first sample carries a measured velocity (plan ruling 7). how:
--- "force" sends whatever (a resync), "stop" sends at zero velocity (the mover left the moving set).
function core.poll(m, x, y, si, tick, how)
	local first = m.pt == nil
	local vx, vy = 0, 0
	if not first and how ~= "stop" and m.psi == si and tick > m.pt then
		vx, vy = (x - m.px) * 60 / (tick - m.pt), (y - m.py) * 60 / (tick - m.pt)
	end
	m.px, m.py, m.pt, m.psi = x, y, tick, si
	local due = how ~= nil
	if not due and not first then
		if m.t == nil or si ~= m.si or tick - m.t >= core.HEARTBEAT then
			due = true
		else
			local s = (tick - m.t) / 60
			local eps = m.kind == "t" and core.TRAIN_EPS or core.EPS
			due = math.abs(x - m.x - m.vx * s) > eps or math.abs(y - m.y - m.vy * s) > eps
		end
	end
	if due then
		m.x, m.y, m.vx, m.vy, m.t, m.si = x, y, vx, vy, tick, si
	end
	return due
end

--- K7: a journey id, "<instance>.<tick>.<train id>", or "<instance>.<tick>.v<unit>" for a vehicle. Deterministic and
--- namespaced per instance (spike 11 :267).
function core.mint(instance, tick, key, kind)
	return instance .. "." .. tick .. "." .. (kind == "v" and "v" or "") .. key
end

local function index(st, kind)
	return kind == "t" and st.by_train or st.by_unit
end

--- Give journey j to the train or vehicle `key` (handle ref, n carriages), creating its mover if this instance has
--- none. The registration moves to ref: the old handle's number is forgotten, so its on_object_destroyed is ignored
--- (§13). register(ref) → registration number is the caller's impure part; the same handle always gives the same
--- number ([api] register_on_object_destroyed), so a number is only cleared while it is still j's.
function core.take(st, j, kind, key, ref, n, register)
	local m = st.movers[j]
	if not m then
		m = { kind = kind }
		st.movers[j] = m
	end
	if m.reg and st.reg[m.reg] == j then
		st.reg[m.reg] = nil
	end
	if m.key and m.key ~= key and index(st, m.kind)[m.key] == j then
		index(st, m.kind)[m.key] = nil
	end
	-- §22.2: a train's kinds and colours are read again at its next sample (movers.lua's shape)
	m.ref, m.key, m.n, m.o = ref, key, n, nil
	m.reg = register(ref)
	st.reg[m.reg] = j
	index(st, kind)[key] = j
end

--- K29: on_train_created takes old_train_id_1's journey, else old_train_id_2's; with both, it keeps the first and
--- returns the second, which the caller ends with gone. It never mints: a train with neither waits for a scan.
function core.train_created(st, old1, old2, id, ref, n, register)
	local j1 = old1 and st.by_train[old1]
	local j2 = old2 and st.by_train[old2]
	if old1 then
		st.by_train[old1] = nil
	end
	if old2 then
		st.by_train[old2] = nil
	end
	local j = j1 or j2
	if j then
		core.take(st, j, "t", id, ref, n, register)
	end
	if j1 and j2 and j1 ~= j2 then
		return j2
	end
	return nil
end

--- §13, K28: a crossing's destination adopts the source's journey over any entry (A → B → A re-adopts on A), and
--- samples it afresh: its first poll here records, its second sends. Returns the journey the handle carried before, if
--- another: the caller ends it with gone, so no ghost of it stays (plan ruling 30).
function core.adopt(st, j, kind, key, ref, n, register)
	local old = index(st, kind)[key]
	core.take(st, j, kind, key, ref, n, register)
	local m = st.movers[j]
	m.pt, m.t = nil, nil
	if old and old ~= j then
		return old
	end
	return nil
end

--- Forget journey j, with its registration and its index entry.
function core.forget(st, j)
	local m = st.movers[j]
	if not m then
		return
	end
	if m.reg and st.reg[m.reg] == j then
		st.reg[m.reg] = nil
	end
	if m.key and index(st, m.kind)[m.key] == j then
		index(st, m.kind)[m.key] = nil
	end
	st.movers[j] = nil
end

--- K34: lines of '{"tick":<tick>,"msgs":[<parts>]}' from each message's own JSON, each line under limit bytes, counted
--- on the real strings. A part too big for a line of its own is dropped and counted. Returns the lines and the count.
function core.cut(tick, parts, limit)
	local head = '{"tick":' .. tick .. ',"msgs":['
	local fixed = #head + 2
	local lines, batch, size, dropped = {}, {}, fixed, 0
	for _, p in ipairs(parts) do
		if fixed + #p >= limit then
			dropped = dropped + 1
		else
			local add = #p + (#batch > 0 and 1 or 0)
			if size + add >= limit then
				lines[#lines + 1] = head .. table.concat(batch, ",") .. "]}"
				batch, size, add = {}, fixed, #p
			end
			batch[#batch + 1] = p
			size = size + add
		end
	end
	if #batch > 0 then
		lines[#lines + 1] = head .. table.concat(batch, ",") .. "]}"
	end
	return lines, dropped
end

core.MIGRATIONS = {
	--- 1: §6.8's state, plus bounds, seeded and resync (plan ruling 6). tile, bounds and resync start nil.
	function(s)
		s.configured, s.seeded, s.forces = false, false, {}
		s.queue, s.pending, s.machines = core.queue(), {}, core.queue()
		s.movers, s.by_train, s.by_unit = {}, {}, {}
		s.walk, s.wi, s.next_scan = {}, 1, 0
		s.reg, s.drops = {}, 0
	end,
	--- 2: plan G's wheel: slot (0..core.WHEEL - 1) → journeys due then; fast: journey → the tick it is due.
	function(s)
		s.wheel, s.fast = {}, {}
	end,
}

--- Run the migrations above s.schema, in order (SP0 §7.4; universal_edges/module/runtime/migrations_core.lua:6-16).
--- It never wipes: a schema newer than this code's is an error, and s is left untouched.
function core.migrate(s)
	local schema = s.schema or 0
	if type(schema) ~= "number" or schema > #core.MIGRATIONS then
		error("minimap storage schema " .. tostring(schema) .. " is newer than this code's " .. #core.MIGRATIONS)
	end
	for i = schema + 1, #core.MIGRATIONS do
		core.MIGRATIONS[i](s)
		s.schema = i
	end
	return s
end

return core
