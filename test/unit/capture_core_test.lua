local t = require("testlib")
local core = require("modules/minimap/capture_core")

--- Journey state as storage.minimap holds it, and a register() that hands out 1, 2, 3, … per new handle, the same
--- number again for the same handle, as register_on_object_destroyed does ([api]), and records what it got.
local function state()
	return { movers = {}, by_train = {}, by_unit = {}, reg = {} }
end
local function registrar()
	local n, got, by = 0, {}, {}
	return function(ref)
		if not by[ref] then
			n = n + 1
			by[ref], got[n] = n, ref
		end
		return by[ref]
	end, got
end
--- How many registrations st still maps.
local function regs(st)
	local n = 0
	for _ in pairs(st.reg) do
		n = n + 1
	end
	return n
end

t.test("bounds and the clip (§6.1, K3, K32): [x1, x2) per axis in chunks, only on the tile's surface", function()
	local tile = { world = "w", x = 0, y = 0, size = 64, surface = "nauvis" }
	t.expect_same(core.bounds(tile), { x1 = -1, y1 = -1, x2 = 1, y2 = 1 })
	local b = core.bounds(tile)
	t.expect_true(core.captured(tile, b, "nauvis", -1, -1), "the low corner is in")
	t.expect_true(core.captured(tile, b, "nauvis", 0, 0), "the high corner is in")
	t.expect_true(not core.captured(tile, b, "nauvis", 1, 0), "x2 is out")
	t.expect_true(not core.captured(tile, b, "nauvis", 0, 1), "y2 is out")
	t.expect_true(not core.captured(tile, b, "nauvis", -2, 0), "below x1 is out")
	t.expect_true(core.captured(tile, b, "mm-lab", 50, 50), "a surface that is no planet is captured whole")
	local west = { world = "w", x = -1, y = 2, size = 512, surface = "nauvis" }
	t.expect_same(core.bounds(west), { x1 = -24, y1 = 24, x2 = -8, y2 = 40 })
	local bw = core.bounds(west)
	t.expect_true(core.captured(west, bw, "nauvis", -24, 24) and core.captured(west, bw, "nauvis", -9, 39), "negative in")
	t.expect_true(not core.captured(west, bw, "nauvis", -8, 30) and not core.captured(west, bw, "nauvis", -25, 30),
		"negative out")
	t.expect_eq(core.bounds(nil), nil, "no tile, no bounds")
	t.expect_true(core.captured(nil, nil, "nauvis", 1000000, -1000000), "no config: no clipping")
end)

t.test("chunk keys differ per surface and per force (C6)", function()
	t.expect_eq(core.key(1, 1, -3, 4), "1:1:-3,4")
	t.expect_true(core.key(1, 1, 0, 0) ~= core.key(2, 1, 0, 0), "two surfaces")
	t.expect_true(core.key(1, 1, 0, 0) ~= core.key(1, 2, 0, 0), "two forces")
	t.expect_true(core.key(1, 1, 1, 23) ~= core.key(1, 1, 12, 3), "no digit run-together")
end)

t.test("the FIFO (K4): order kept; the cap refuses event pushes; a push without a cap (resync) passes it", function()
	local q = core.queue()
	t.expect_eq(core.pop(q), nil, "empty")
	t.expect_true(core.push(q, "a", 3) and core.push(q, "b", 3) and core.push(q, "c", 3), "three fit")
	t.expect_true(not core.push(q, "d", 3), "the fourth event push is refused")
	t.expect_eq(core.size(q), 3)
	t.expect_true(core.push(q, "forced"), "a resync push is exempt")
	t.expect_eq(core.size(q), 4)
	t.expect_eq(core.pop(q), "a")
	t.expect_eq(core.pop(q), "b")
	t.expect_eq(core.pop(q), "c")
	t.expect_eq(core.pop(q), "forced")
	t.expect_eq(core.pop(q), nil)
	t.expect_same(q, { head = 1, tail = 0 }, "an empty queue resets its indexes")
	t.expect_eq(core.CAP, 20000)
end)

t.test("dead reckoning (K6): the first poll records; the second sends with the measured velocity in tiles a second",
	function()
		local m = {}
		t.expect_true(not core.poll(m, 0, 5, 1, 1000), "first sight only records (plan ruling 7)")
		t.expect_true(core.poll(m, 3, 5, 1, 1030), "the second poll sends")
		t.expect_eq(m.vx, 6, "3 tiles in 30 ticks is 6 tiles a second")
		t.expect_eq(m.vy, 0)
		t.expect_same({ m.x, m.y, m.t, m.si }, { 3, 5, 1030, 1 })
	end)

t.test("dead reckoning (K6): nothing on a straight line; a send past ε on either axis and at 600 ticks", function()
	local m = {}
	core.poll(m, 0, 0, 1, 0)
	core.poll(m, 3, 0, 1, 30) -- sent: 6 tiles a second along x
	for tick = 60, 600, 30 do
		t.expect_true(not core.poll(m, (tick / 10), 0, 1, tick), "on the prediction at " .. tick)
	end
	t.expect_true(core.poll(m, 63, 0, 1, 630), "600 ticks after the last sample: a heartbeat")
	t.expect_eq(m.t, 630)
	t.expect_true(not core.poll(m, 66 + 0.9, 0, 1, 660), "0.9 tiles off: within ε")
	t.expect_true(core.poll(m, 69 + 1.1, 0, 1, 690), "1.1 tiles off on x: sent")
	t.expect_true(core.poll(m, m.x + m.vx / 2, 1.5, 1, 720), "1.5 tiles off on y: sent")
end)

t.test("dead reckoning: a surface change sends at zero velocity; force sends; stop sends zero velocity", function()
	local m = {}
	core.poll(m, 0, 0, 1, 0)
	core.poll(m, 3, 0, 1, 30)
	t.expect_true(core.poll(m, 3.5, 0, 2, 35), "a new surface")
	t.expect_same({ m.vx, m.vy, m.si }, { 0, 0, 2 }, "no velocity across surfaces")
	t.expect_true(core.poll(m, 3.5, 0, 2, 36, "force"), "force sends on the prediction")
	core.poll(m, 6.5, 0, 2, 66, "force")
	t.expect_eq(m.vx, 6, "force keeps the measured velocity")
	t.expect_true(core.poll(m, 9.5, 0, 2, 96, "stop"), "stop sends")
	t.expect_same({ m.x, m.vx, m.vy }, { 9.5, 0, 0 }, "stop: the position, at zero velocity")
	local fresh = {}
	t.expect_true(core.poll(fresh, 1, 1, 1, 5, "force"), "force sends even at first sight (a resync)")
end)

t.test("journey ids (K7): <instance>.<tick>.<train id>, and v<unit> for a vehicle", function()
	t.expect_eq(core.mint(4242, 600, 32, "t"), "4242.600.32")
	t.expect_eq(core.mint(4242, 600, 750, "v"), "4242.600.v750")
end)

t.test("K29 / spike 11: one journey from the destination's 55 through 72, 74, 76 and 78 (old_train_id_2 each join)",
	function()
		local st, register, got = state(), registrar()
		-- the first batch: carriages create trains 33 … 55 among themselves, none with a journey
		for id = 33, 55 do
			t.expect_eq(core.train_created(st, id > 33 and id - 1 or nil, nil, id, { id = id }, id - 32, register), nil)
		end
		t.expect_eq(next(st.movers), nil, "on_train_created never mints")
		core.adopt(st, "4242.1332.32", "t", 55, { id = 55 }, 12, register)
		local prev = 55
		for _, id in ipairs({ 72, 74, 76, 78 }) do
			-- the joining carriage's own train (id - 1) was made and merged in one tick, so it never had a journey
			core.train_created(st, id - 1, prev, id, { id = id }, 12 + (id - 70) / 2, register)
			prev = id
		end
		t.expect_eq(st.by_train[78], "4242.1332.32", "78 carries the source's journey")
		for _, id in ipairs({ 55, 72, 74, 76 }) do
			t.expect_eq(st.by_train[id], nil, "the old id " .. id .. " is cleared")
		end
		local m = st.movers["4242.1332.32"]
		t.expect_same({ m.ref.id, m.key, m.n, m.kind }, { 78, 78, 16, "t" })
		t.expect_eq(regs(st), 1, "only the current train is registered")
		t.expect_eq(st.reg[m.reg], "4242.1332.32")
		t.expect_eq(got[m.reg].id, 78, "the registration is the new train's")
	end)

t.test("K29: the source's shrink at commit keeps the journey through old_train_id_1", function()
	local st, register = state(), registrar()
	core.take(st, "j", "t", 32, { id = 32 }, 16, register)
	local prev = 32
	for id = 56, 70 do
		t.expect_eq(core.train_created(st, prev, nil, id, { id = id }, 16 - (id - 55), register), nil)
		prev = id
	end
	t.expect_eq(st.by_train[70], "j")
	t.expect_eq(st.movers.j.n, 1)
	t.expect_eq(regs(st), 1)
end)

t.test("K29: a merge keeps old_train_id_1's journey and ends the other; a split's second train takes none", function()
	local st, register = state(), registrar()
	core.take(st, "a", "t", 10, { id = 10 }, 1, register)
	core.take(st, "b", "t", 11, { id = 11 }, 1, register)
	t.expect_eq(core.train_created(st, 10, 11, 12, { id = 12 }, 2, register), "b", "b ends")
	t.expect_eq(st.by_train[12], "a")
	t.expect_eq(st.by_train[11], nil)
	core.forget(st, "b")
	t.expect_eq(regs(st), 1, "b's registration went with it")
	core.take(st, "c", "t", 20, { id = 20 }, 2, register)
	t.expect_eq(core.train_created(st, 20, nil, 21, { id = 21 }, 1, register), nil)
	t.expect_eq(core.train_created(st, 20, nil, 22, { id = 22 }, 1, register), nil)
	t.expect_eq(st.by_train[21], "c", "the first half takes the journey")
	t.expect_eq(st.by_train[22], nil, "the second waits for a scan")
end)

t.test("adoption over an existing entry returns the displaced journey, whose forgetting leaves the adopted one's "
	.. "registration (plan ruling 30)", function()
	local st, register = state(), registrar()
	local ref = { id = 40 }
	core.take(st, "x", "t", 40, ref, 1, register)
	local m = st.movers.x
	core.poll(m, 0, 0, 1, 0)
	core.poll(m, 1, 0, 1, 30)
	t.expect_eq(core.adopt(st, "y", "t", 40, ref, 3, register), "x", "x is displaced")
	core.forget(st, "x")
	t.expect_eq(st.movers.x, nil, "no ghost of x")
	t.expect_eq(st.by_train[40], "y", "the train now carries y")
	t.expect_eq(st.reg[st.movers.y.reg], "y", "the same handle, the same number: y keeps it")
	t.expect_true(st.movers.y.pt == nil and st.movers.y.t == nil, "y is sampled afresh")
	t.expect_eq(core.adopt(st, "y", "t", 40, ref, 3, register), nil, "re-adopting y displaces nothing")
	core.adopt(st, "y", "t", 41, ref, 3, register)
	t.expect_eq(st.by_train[40], nil, "adopting y onto a new key leaves no entry at the old one")
	core.adopt(st, "v1", "v", 750, { unit_number = 750 }, nil, register)
	t.expect_eq(st.by_unit[750], "v1", "a vehicle goes by unit number")
	core.forget(st, "v1")
	t.expect_true(st.by_unit[750] == nil and st.movers.v1 == nil, "forgotten")
	core.forget(st, "nope")
end)

--- The parts of each line, checking its envelope; joined, they must equal the input parts joined.
local function parts_of(lines, tick)
	local head, out = '{"tick":' .. tick .. ',"msgs":[', {}
	for _, line in ipairs(lines) do
		t.expect_eq(string.sub(line, 1, #head), head, "the envelope's head")
		t.expect_eq(string.sub(line, -2), "]}", "the envelope's tail")
		out[#out + 1] = string.sub(line, #head + 1, -3)
	end
	return table.concat(out, ",")
end

t.test("the cut (K34): every line is under 3,500 bytes, counted on the real strings, a 10-digit tick included", function()
	local chunk = '{"d":"' .. string.rep("A", 2750) .. '","f":"player","s":"nauvis","type":"mm.chunk","x":-12,"y":7}'
	local sample = '{"f":"player","j":"4242.1332.32","k":"t","n":16,"name":"locomotive","vx":18.000000000000004,'
		.. '"vy":0,"x":20001.5,"y":-2.25}'
	local parts = { chunk }
	for i = 1, 40 do
		parts[#parts + 1] = sample
		if i % 13 == 0 then
			parts[#parts + 1] = chunk
		end
	end
	for _, tick in ipairs({ 0, 4294967295 }) do
		local lines, dropped = core.cut(tick, parts, core.LIMIT)
		t.expect_eq(dropped, 0)
		for _, line in ipairs(lines) do
			t.expect_true(#line < 3500, "a line of " .. #line .. " bytes")
		end
		t.expect_eq(parts_of(lines, tick), table.concat(parts, ","), "every part, once, in order")
	end
	local lines = core.cut(7, {}, core.LIMIT)
	t.expect_eq(#lines, 0, "nothing to print")
end)

t.test("the cut (K34): a part that fills a line exactly to 3,499 bytes is kept; one byte more is dropped and counted",
	function()
		local head = '{"tick":4294967295,"msgs":['
		local fits = string.rep("x", 3499 - #head - 2)
		local lines, dropped = core.cut(4294967295, { "a", fits, "b" }, core.LIMIT)
		t.expect_eq(dropped, 0)
		t.expect_eq(#lines, 3, "a line each: the big part fits only alone")
		t.expect_eq(#lines[2], 3499)
		lines, dropped = core.cut(4294967295, { "a", fits .. "x", "b" }, core.LIMIT)
		t.expect_eq(dropped, 1, "the oversized part is dropped and counted")
		t.expect_eq(#lines, 1, "the rest share a line")
		t.expect_eq(parts_of(lines, 4294967295), "a,b")
	end)

t.test("migrations (§6.8): a new table becomes schema 1; schema 1 is left as it is; a newer schema is refused", function()
	local s = core.migrate({})
	t.expect_eq(s.schema, 1)
	t.expect_true(s.configured == false and s.seeded == false and s.drops == 0 and s.wi == 1 and s.next_scan == 0,
		"flags and counters")
	t.expect_same(s.queue, { head = 1, tail = 0 })
	t.expect_same(s.machines, { head = 1, tail = 0 })
	for _, k in ipairs({ "forces", "pending", "movers", "by_train", "by_unit", "walk", "reg" }) do
		t.expect_same(s[k], {}, k)
	end
	s.marker = "kept"
	core.push(s.queue, "item")
	core.migrate(s)
	t.expect_true(s.marker == "kept" and core.size(s.queue) == 1, "schema 1 is never wiped")
	local newer = { schema = 2, marker = "untouched" }
	t.expect_error(function() core.migrate(newer) end, "schema 2 is newer")
	t.expect_eq(newer.marker, "untouched")
end)

t.test("§22.1 (M14): a tile's planets are tiled, less its exclude list; tile.surface always; nothing else", function()
	local tile = { world = "w", x = 0, y = 0, size = 64, surface = "nauvis", exclude = { "aquilo" } }
	local b = core.bounds(tile)
	t.expect_true(core.tiled(tile, "nauvis", nil), "tile.surface, whatever its planet")
	t.expect_true(core.tiled(tile, "vulcanus", "vulcanus"), "a planet")
	t.expect_true(not core.tiled(tile, "aquilo", "aquilo"), "an excluded planet")
	t.expect_true(not core.tiled(tile, "platform-1", nil), "a platform")
	t.expect_true(not core.tiled(nil, "vulcanus", "vulcanus"), "no tile: nothing is tiled")
	t.expect_true(core.tiled({ world = "w", x = 0, y = 0, size = 64, surface = "nauvis" }, "gleba", "gleba"),
		"no exclude list")
	t.expect_true(core.captured(tile, b, "vulcanus", 0, 0, "vulcanus"), "a tiled planet's chunk inside the bounds")
	t.expect_true(not core.captured(tile, b, "vulcanus", 1, 1, "vulcanus"), "not one outside them")
	t.expect_true(core.captured(tile, b, "aquilo", 1, 1, "aquilo"), "an excluded planet is captured whole")
	t.expect_true(core.captured(tile, b, "platform-1", 500, -500, nil), "a platform is captured whole")
	t.expect_eq(core.planet({ name = "nauvis", planet = { name = "nauvis" } }), "nauvis")
	t.expect_eq(core.planet({ name = "platform-1" }), nil)
end)

t.test("dead reckoning's ε (§22.2): half a tile for a train, a tile for a vehicle or a player", function()
	local function moving(kind)
		local m = { kind = kind }
		core.poll(m, 0, 0, 1, 0)
		core.poll(m, 3, 0, 1, 30) -- sent: 6 tiles a second along x
		return m
	end
	local tr, car = moving("t"), moving("v")
	t.expect_true(not core.poll(tr, 6 + 0.4, 0, 1, 60), "a train 0.4 tiles off: within its half tile")
	t.expect_true(core.poll(tr, 9 + 0.6, 0, 1, 90), "a train 0.6 tiles off: sent")
	t.expect_true(not core.poll(car, 6 + 0.6, 0, 1, 60), "a car 0.6 tiles off: within its tile")
	t.expect_true(core.poll(car, 9 + 1.1, 0, 1, 90), "a car 1.1 tiles off: sent")
	t.expect_eq(core.TRAIN_EPS, 0.5)
end)

t.test("§22.2: core.take clears a train's kinds, so its next sample reads them again (first sight, on_train_created, "
	.. "adoption)", function()
	local st, register = state(), registrar()
	core.take(st, "x", "t", 40, { id = 40 }, 2, register)
	st.movers.x.o = "LC"
	core.train_created(st, 40, nil, 41, { id = 41 }, 3, register)
	t.expect_eq(st.movers.x.o, nil, "the train changed: its kinds are read again")
	st.movers.x.o = "LCC"
	core.adopt(st, "x", "t", 41, { id = 41 }, 3, register)
	t.expect_eq(st.movers.x.o, nil, "adopted: read again")
end)

t.test("K30: a train keeps the end it last led with while stopped, and starts on its front", function()
	t.expect_true(core.forward(nil, 0), "never moved: the front")
	t.expect_true(core.forward(nil, 0.3))
	t.expect_true(not core.forward(nil, -0.3))
	t.expect_true(not core.forward(false, 0), "stopped after backing: still the back")
	t.expect_true(core.forward(true, 0), "stopped after going forward: still the front")
end)

t.test("§22.2: a train's heading is an orientation from its second carriage towards the leading one, or its own "
	.. "orientation (plus a half turn from the back) with one carriage", function()
	t.expect_eq(core.heading(10, 0, 3, 0), 0.25, "east")
	t.expect_eq(core.heading(0, 10, 0, 3), 0.5, "south")
	t.expect_eq(core.heading(0, 0, 7, 0), 0.75, "west")
	t.expect_eq(core.heading(0, 0, 0, 7), 0, "north")
	t.expect_eq(core.heading(1, 1, 0, 2), 0.125, "north-east, 3 decimals")
	t.expect_eq(core.heading(0, 0, nil, nil, 0.25, false), 0.25, "one carriage leading with its front: its orientation")
	t.expect_eq(core.heading(0, 0, nil, nil, 0.25, true), 0.75, "leading with its back: half a turn on")
	t.expect_eq(core.heading(0, 0, nil, nil, 0.9996, false), 0, "rounded, then wrapped: never 1")
end)
