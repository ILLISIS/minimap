local t = require("modules/v2_test/testlib")
local mt = require("modules/v2_test/minimap")
local control = require("modules/minimap/control")
local core = require("modules/minimap/capture_core")
local movers = require("modules/minimap/movers")
local tick = require("modules/minimap/tick")
-- Factorio allows require only while the file loads: UE's seams and the loopback, when UE is patched in.
local loop, seams
if control.ue then
	loop = require("modules/v2_test/loopback")
	seams = require("modules/universal_edges/transports/train_seams")
end

-- Minimap plan A Task 4 (spec §16.3 Movers and Crossing). Lab surface mm-m: rails on rows y = 1, 9, 17 and 25 from x 1
-- to 2001, cars at x 100 on rows y 40–157, a fake player on y 60; mm-d for the deleted surface. Ticks 250–1850. With UE:
-- the loopback crossing on nauvis x 19990–20030 and the scripted rejection on sp3b row 50000, ticks 1000–2901.

local function by_train(tr)
	return storage.minimap.by_train[tr.id]
end

--- fn(k) at every offset k from `from` to `to`.
local function each(ctx, from, to, fn)
	for k = from, to do
		ctx.at(k, function()
			fn(k)
		end)
	end
end

local S -- mm-m, made at tick 250 by the first case

t.case("movers: a train at constant speed sends a first sample, then only heartbeats; stopping sends zero velocity; "
	.. "destroying it sends gone (§6.3, K6)", function(ctx)
	local A, j, at
	ctx.at(20, function()
		mt.config()
	end)
	ctx.at(250, function()
		S = mt.surface("mm-m", 0, 2047, -32, 159)
		for _, y in ipairs({ 1, 9, 17, 25 }) do
			mt.line(S, 1, 2001, y)
		end
		A = mt.train(S, 1, 100, "L")
		at = game.tick
	end)
	-- moving from 500 only: Task 3's resyncs at 410 and 450 force a sample of every known mover, and A is unknown
	-- until the scan sees it move
	each(ctx, 500, 1349, function()
		A.speed = 0.3
	end)
	ctx.at(1350, function()
		j = by_train(A)
		ctx.expect(j ~= nil, "the scan minted a journey")
		local got = mt.samples(j or "", at, game.tick)
		ctx.expect(#got == 2, "a first sample and one heartbeat in 850 ticks, got " .. #got)
		if #got == 2 then
			ctx.expect(math.abs(got[1].vx - 18) < 1 and math.abs(got[1].vy) < 0.01, "18 tiles a second east: " .. got[1].vx)
			local gap = got[2].tick - got[1].tick
			ctx.expect(gap >= 600 and gap <= 660, "the heartbeat 600–660 ticks later, got " .. gap)
			ctx.expect(got[1].k == "t" and got[1].name == "locomotive" and got[1].n == 1 and got[1].f == "player"
				and got[1].s == "mm-m", "the sample's fields")
		end
		A.speed = 0
		at = game.tick
	end)
	ctx.at(1410, function()
		-- a poll of the current walk may first send the braked position; the scan's stop poll ends at zero velocity
		local stop = mt.samples(j or "", at, game.tick)
		local last = stop[#stop]
		ctx.expect(last ~= nil and last.vx == 0 and last.vy == 0, "the last sample is at zero velocity")
		at = game.tick
		A.carriages[1].destroy()
	end)
	ctx.at(1420, function()
		local gone = mt.samples(j or "", at, game.tick)
		ctx.expect(#gone == 1 and gone[1].gone == true, "gone")
		ctx.expect(storage.minimap.movers[j or ""] == nil, "forgotten")
	end)
end)

t.case("movers: a 1-1 train is sampled at its leading end both ways, so at back_stock while speed < 0 (K30, Review "
	.. "Focus 5)", function(ctx)
	local B, pos = nil, {}
	ctx.at(252, function()
		B = mt.train(S, 9, 1500, "Ll")
	end)
	-- from 500, as the first case's train: unknown at Task 3's resyncs, whose forced samples carry a later tick
	each(ctx, 500, 1100, function(k)
		-- the speed and positions this step reads at tick T are those the poll read at T: nothing moves inside a tick, and
		-- the step runs after the poll, before it sets this tick's speed
		pos[game.tick] = { B.speed, B.front_stock.position, B.back_stock.position }
		B.speed = k <= 800 and -0.3 or 0.3
	end)
	ctx.at(1101, function()
		local ways = { [-1] = 0, [1] = 0 }
		for _, x in ipairs(mt.samples(by_train(B) or "", 0, game.tick)) do
			local p = pos[x.tick]
			if p and not x.gone and x.vx ~= 0 then
				-- K30: the leading end is back_stock while speed < 0, front_stock otherwise; the finite-difference velocity
				-- of the sample at the reversal still points the old way, so the way counted is the speed's
				local lead = p[1] < 0 and p[3] or p[2]
				ctx.expect(math.abs(x.x - lead.x) < 0.01 and math.abs(x.y - lead.y) < 0.01,
					"sampled at the leading end at " .. x.tick)
				local dir = p[1] < 0 and -1 or 1
				local prev = pos[x.tick - 1]
				if prev and (prev[1] > 0) == (p[1] > 0) and (x.vx > 0) == (p[1] > 0) then
					-- geometric check: with vx and the speed agreeing (not at the reversal, whose vx lags a tick), the stock
					-- sampled is the one further along vx
					local far = (p[2].x - p[3].x) * (x.vx > 0 and 1 or -1) > 0 and p[2] or p[3]
					ctx.expect(math.abs(x.x - far.x) < 0.01, "further along vx at " .. x.tick)
				end
				ways[dir] = ways[dir] + 1
			end
		end
		ctx.expect(ways[-1] >= 1 and ways[1] >= 1, "samples both ways: " .. ways[-1] .. ", " .. ways[1])
	end)
end)

t.case("movers: a 16-carriage train is one mover, with n = 16 (§6.3)", function(ctx)
	local C
	ctx.at(252, function()
		C = mt.train(S, 17, 300, "L" .. string.rep("C", 15))
	end)
	each(ctx, 253, 500, function()
		C.speed = 0.2
	end)
	ctx.at(501, function()
		local j = by_train(C)
		local got = mt.samples(j or "", 0, game.tick)
		ctx.expect(#got >= 1, "sampled")
		for _, x in ipairs(got) do
			ctx.expect(x.n == 16, "n = 16")
		end
		for _, mv in ipairs(mt.msgs("mm.move", 0, game.tick, function(m) return m.s == "mm-m" end)) do
			for _, x in ipairs(mv.m) do
				if x.y and math.abs(x.y - 17) < 1 then
					ctx.expect(x.j == j, "one mover on row 17, got " .. tostring(x.j))
				end
			end
		end
	end)
end)

t.case("movers: a train's samples carry its carriages' kinds and its leading locomotive's colour, from its leading "
	.. "end, both ways (§22.2)", function(ctx)
	local K
	local seen = {} -- tick → { speed, front_stock x, back_stock x }, as the poll at that tick read them
	ctx.at(252, function()
		-- east to west: L (blue, facing east) C F A l (green, facing west); §22.6: upper case faces the leading end
		K = mt.train(S, 25, 1200, "LCFAl")
		for _, c in ipairs(K.carriages) do
			if c.type == "locomotive" then
				c.color = c.position.x > 1190 and { r = 0, g = 0, b = 1 } or { r = 0, g = 1, b = 0 }
			end
		end
	end)
	each(ctx, 253, 420, function(k)
		-- what this step reads at tick T is what the poll read at T (see the K30 case)
		seen[game.tick] = { K.speed, K.front_stock.position.x, K.back_stock.position.x }
		K.speed = k <= 340 and 0.2 or -0.2
	end)
	ctx.at(421, function()
		local ways = { east = 0, west = 0 }
		for _, x in ipairs(mt.samples(by_train(K) or "", 0, game.tick)) do
			local p = seen[x.tick]
			if p and not x.gone then
				-- the leading end is front_stock while speed >= 0, else back_stock (K30)
				local lead, other = p[2], p[3]
				if p[1] < 0 then
					lead, other = p[3], p[2]
				end
				local way = lead > other and "east" or "west"
				local want = way == "east" and { "LCFAl", "0000ff" } or { "Lafcl", "00ff00" }
				ctx.expect(x.o == want[1] and x.c == want[2] and x.n == 5,
					way .. " at " .. x.tick .. ": " .. tostring(x.o) .. ", " .. tostring(x.c))
				ways[way] = ways[way] + 1
			end
		end
		ctx.expect(ways.east >= 1 and ways.west >= 1, "samples both ways: " .. ways.east .. ", " .. ways.west)
	end)
end)

t.case("movers: at most 8 polls a tick, and the vehicles are cars and spidertrons, never rolling stock (§6.3, K6)",
	function(ctx)
		local cars, prev_walk, prev_wi = {}, nil, nil
		ctx.at(252, function()
			for k = 0, 39 do
				local car = assert(S.create_entity{ name = "car", position = { 100, 40 + 3 * k }, force = "player" })
				car.orientation = 0.25
				cars[#cars + 1] = car
			end
		end)
		each(ctx, 253, 420, function()
			for _, car in ipairs(cars) do
				car.speed = 0.1
			end
			local st = storage.minimap
			if prev_walk then
				local polls = st.walk == prev_walk and st.wi - prev_wi or st.wi - 1
				ctx.expect(polls <= core.WALK, polls .. " polls at tick " .. game.tick)
			end
			prev_walk, prev_wi = st.walk, st.wi
		end)
		ctx.at(421, function()
			local seen, wrong = 0, 0
			for _, m in pairs(storage.minimap.movers) do
				if m.kind == "v" and m.ref.valid then
					if m.ref.type == "car" then
						seen = seen + 1
					elseif m.ref.type ~= "spider-vehicle" then
						wrong = wrong + 1
					end
				end
			end
			ctx.expect(seen >= 40, "the 40 cars are vehicles, got " .. seen)
			ctx.expect(wrong == 0, "no rolling stock among the vehicles")
		end)
	end)

t.case("movers: a car's and a spidertron's samples carry o, c and h (§22.5)", function(ctx)
	local car, spider
	ctx.at(252, function()
		car = assert(S.create_entity{ name = "car", position = { 100, 170 }, force = "player" })
		car.orientation = 0.25
		car.color = { r = 0, g = 0, b = 1 } -- the spidertron keeps base's orange
		spider = assert(S.create_entity{ name = "spidertron", position = { 100, 190 }, force = "player" })
		spider.autopilot_destination = { 300, 190 }
	end)
	each(ctx, 253, 420, function()
		car.speed = 0.1
	end)
	ctx.at(421, function()
		for want, v in pairs({ C = car, S = spider }) do
			local j = storage.minimap.by_unit[v.unit_number]
			local got = false
			for _, x in ipairs(mt.samples(j or "", 252, game.tick)) do
				if not x.gone then
					got = true
					ctx.expect(x.o == want and x.h ~= nil, want .. ": o = " .. tostring(x.o) .. ", h = " .. tostring(x.h))
					ctx.expect(x.c == (want == "C" and "0000ff" or "ff8000"), want .. ": c = " .. tostring(x.c))
				end
			end
			ctx.expect(got, want .. " sent samples")
		end
	end)
end)

t.case("movers: a player without a character is walked as p:<name> (C9)", function(ctx)
	local real, fake, at = movers.players, nil, nil
	ctx.at(252, function()
		fake = { valid = true, name = "mm-ghost", force = game.forces.player, physical_surface_index = S.index, connected = true,
			physical_position = { x = 0, y = 60 } }
		movers.players = function()
			return { fake }
		end
	end)
	each(ctx, 253, 700, function(k)
		fake.physical_position = { x = (k - 253) * 0.2, y = 60 }
	end)
	ctx.at(701, function()
		local got = mt.samples("p:mm-ghost", 0, game.tick)
		ctx.expect(#got >= 1, "sampled")
		if got[1] then
			ctx.expect(got[1].k == "p" and got[1].name == "mm-ghost" and got[1].f == "player" and got[1].s == "mm-m",
				"the sample's fields")
			ctx.expect(math.abs(got[1].vx - 12) < 0.5, "12 tiles a second, got " .. got[1].vx)
		end
		-- no longer connected: the scan's stop poll ends it (the resync's pass is pinned in the resync case)
		fake.connected = false
		movers.players = real
		at = game.tick
	end)
	ctx.at(760, function()
		local gone = mt.samples("p:mm-ghost", at, game.tick)
		ctx.expect(#gone == 1 and gone[1].gone == true, "gone, and no sample, once it is no longer connected")
		ctx.expect(storage.minimap.movers["p:mm-ghost"] == nil, "forgotten")
	end)
end)

t.case("movers: a moving train split mid-walk keeps one journey, polled on whichever half took it (K29, Review "
	.. "Focus 1)", function(ctx)
	local loco, wagon, j, at
	ctx.at(1400, function()
		local tr = mt.train(S, 25, 300, "LC")
		loco, wagon = tr.carriages[1], tr.carriages[2]
	end)
	each(ctx, 1401, 1500, function()
		loco.train.speed = 0.3
	end)
	ctx.at(1450, function()
		j = by_train(loco.train)
		ctx.expect(j ~= nil, "minted before the split")
		at = game.tick
		local split = wagon.disconnect_rolling_stock(defines.rail_direction.front)
			or wagon.disconnect_rolling_stock(defines.rail_direction.back)
		ctx.expect(split, "split")
	end)
	ctx.at(1501, function()
		local a, b = by_train(loco.train), by_train(wagon.train)
		ctx.expect(loco.train.id ~= wagon.train.id, "two trains")
		ctx.expect((a == j) ~= (b == j), "exactly one half carries j: " .. tostring(a) .. ", " .. tostring(b))
		for _, x in ipairs(mt.samples(j or "", at, game.tick)) do
			ctx.expect(not x.gone, "no gone for j")
		end
	end)
end)

t.case("movers: a journey adopted through materialized and destroyed before any sample ends with gone (UE refusal after "
	.. "materialized)", function(ctx)
	local car, at
	ctx.at(1700, function()
		car = assert(S.create_entity{ name = "car", position = { 500, 100 }, force = "player" })
		at = game.tick
		movers.materialized({ type = "vehicle", edge = "e", cid = "c" }, car, { j = "mm.adopt-gone" }, { trace = "mm.ag" })
		ctx.expect(storage.minimap.movers["mm.adopt-gone"].s == "mm-m", "the adopted mover knows its surface")
		car.destroy()
	end)
	ctx.at(1720, function()
		local gone = mt.samples("mm.adopt-gone", at, game.tick)
		ctx.expect(#gone == 1 and gone[1].gone == true, "one gone, got " .. #gone)
	end)
end)

t.case("movers and terrain: a deleted surface's queued chunks are skipped and its vehicle ends with gone (Review "
	.. "Focus 2)", function(ctx)
	local car, j, at
	ctx.at(1600, function()
		local d = mt.surface("mm-d", 0, 95, 0, 95)
		car = assert(d.create_entity{ name = "car", position = { 40, 40 }, force = "player" })
		car.orientation = 0.25
	end)
	each(ctx, 1601, 1680, function()
		car.speed = 0.1
	end)
	ctx.at(1681, function()
		j = storage.minimap.by_unit[car.unit_number]
		ctx.expect(j ~= nil and storage.minimap.movers[j].s == "mm-d", "the car is a sampled vehicle")
		at = game.tick
		for x = 0, 2 do
			for y = 0, 1 do
				mt.chart("mm-d", x, y, mt.solid(40 + x + y))
				mm_rt.seam.charted("mm-d", "player", x, y)
			end
		end
		game.delete_surface("mm-d")
	end)
	ctx.at(1730, function()
		ctx.expect(core.size(storage.minimap.queue) == 0, "the queue drained")
		local after = mt.samples(j or "", at, game.tick)
		local last = after[#after]
		ctx.expect(last ~= nil and last.gone == true and last.s == "mm-d", "gone, on mm-d")
		ctx.expect(storage.minimap.movers[j or ""] == nil, "forgotten")
	end)
end)

t.case("resync: a sample for every known mover, parked ones included, all after mm.surfaces (§6.7 steps 1–2, plan "
	.. "ruling 26)", function(ctx)
	local at
	ctx.at(1800, function()
		at = game.tick
		-- a gone already waiting for mm-m, as an on_object_destroyed between two ticks leaves one: the resync's samples
		-- must not join its mm.move, which precedes mm.surfaces
		tick.move("mm-m", { j = "mm.order", gone = true })
		-- a player who was connected when the save was taken: a mover, but no longer connected, and no on_player_left_game
		storage.minimap.movers["p:mm-gh2"] = { kind = "p", s = "mm-m", ref = { valid = true, connected = false } }
		mm_rt.resync("mm.m1")
	end)
	ctx.at(1850, function()
		local long = 0
		for _, mv in ipairs(mt.msgs("mm.move", at, at + 1, function(m) return m.s == "mm-m" end)) do
			for _, x in ipairs(mv.m) do
				if x.n == 16 then
					long = long + 1
				end
			end
		end
		ctx.expect(long == 1, "the parked 16-carriage train is sampled, got " .. long)
		local surfaces, early = false, 0
		for _, b in ipairs(mt.batches) do
			if b.data.tick == at + 1 then
				for _, m in ipairs(b.data.msgs) do
					if m.type == "mm.surfaces" then
						surfaces = true
					elseif m.type == "mm.move" and not surfaces then
						for _, x in ipairs(m.m) do
							if not x.gone then
								early = early + 1
							end
						end
					end
				end
			end
		end
		ctx.expect(surfaces and early == 0, "no re-sent sample precedes mm.surfaces, got " .. early)
		local g2 = 0
		for _, mv in ipairs(mt.msgs("mm.move", at, at + 1, function(m) return m.s == "mm-m" end)) do
			for _, x in ipairs(mv.m) do
				if x.j == "p:mm-gh2" then
					g2 = g2 + (x.gone and 1 or 100)
				end
			end
		end
		ctx.expect(g2 == 1, "the disconnected player ends with one gone and no sample, got " .. g2)
		ctx.expect(storage.minimap.movers["p:mm-gh2"] == nil, "forgotten")
	end)
	-- the walk takes ticks (K33): about 80 in the plugins pass, whose UE surfaces hold ≈ 20,000 generated chunks
	ctx.at(1990, function()
		local done = mt.msgs("mm.resynced", at, game.tick, function(m) return m.trace == "mm.m1" end)
		ctx.expect(#done == 1 and done[1].counts.movers >= 4, "mm.resynced counts the movers")
	end)
end)

local CONNECTOR = { cid = "t1", type = "train", pos = 4, width = 6, params = { dir = "ab", layer = "ground" } }

t.case("crossing (UE): the destination takes the source's journey once, under the crossing's trace, through every "
	.. "join (§13, K28, K29; spike 11 P8)", function(ctx)
	if not control.ue then
		ctx.at(3800, function()
			ctx.expect(#mt.msgs("mm.adopt", 0, game.tick, function(m) return m.j ~= "mm.adopt-gone" end) == 0,
				"standalone: no mm.adopt, ever (bar the materialized case's direct call)")
		end)
		return
	end
	-- spike 11's crossing (spikes/11-minimap-probes/crossing_game_test.lua:75-95), 11,000 tiles east and 1,000 ticks
	-- later; lanes_game_test.lua's empty ue.edge.sync at tick 95 gives synced_boot, as the circuit tests rely on
	ctx.at(1000, function()
		loop.ground(19990, 2960, 20030, 3330)
		loop.ground(19990, 1690, 20030, 2120)
		loop.edge("mm-t", 16, { CONNECTOR }, { 20000, 3000, 0 }, { 20016, 2000, 8 })
	end)
	ctx.at(1001, function()
		seams.track("mm-t-x", "t1", 150)
		seams.track("mm-t-y", "t1", 150, "MM Z")
	end)
	ctx.at(1590, function()
		for _, id in ipairs({ "mm-t-x", "mm-t-y" }) do
			local ep = seams.endpoint(id, "t1")
			ctx.expect(ep.state == "ready" and ep.partner and ep.partner.state == "ready", id .. " ready and partnered")
		end
	end)
	ctx.at(1600, function()
		seams.add("mm-t-x", "t1", { layout = "L" .. string.rep("C", 15), at = 30, next = "MM Z", cargo = 50 })
	end)
	local j, adopted
	for k = 1610, 2900, 10 do
		ctx.at(k, function()
			local src = seams.trains("mm-t-x", "t1")
			if not j and src[1] then
				j = by_train(src[1])
			end
			for _, tr in ipairs(seams.trains("mm-t-y", "t1")) do
				local mine = by_train(tr)
				ctx.expect(mine == nil or mine == j, "a destination train carries only the source's journey at " .. k)
			end
			if j and not adopted then
				adopted = mt.msgs("mm.adopt", 0, game.tick, function(m) return m.j == j end)[1]
				if adopted then
					-- UE's ue.transfer lines of this crossing carry the same trace (spike 11 :239)
					ctx.expect_ipc("universal_edges:out", '"trace":"' .. adopted.trace .. '"')
				end
			end
		end)
	end
	ctx.at(2901, function()
		ctx.expect(j ~= nil, "the source's train had a journey before it crossed")
		ctx.expect(adopted ~= nil, "mm.adopt was sent")
		ctx.expect(#mt.msgs("mm.adopt", 0, game.tick, function(m) return m.j == j end) == 1, "mm.adopt once")
		local lines = mt.msgs("trace", 0, game.tick, function(m)
			return m.op == "minimap.journey" and m.phase == "adopted" and m.journey == j
		end)
		ctx.expect(#lines == 1 and adopted and lines[1].trace == adopted.trace, "minimap.journey adopted, under the trace")
		local dst = seams.trains("mm-t-y", "t1")
		ctx.expect(#dst == 1 and #dst[1].carriages == 16 and by_train(dst[1]) == j, "the assembled train carries j")
		local after = 0
		for _, x in ipairs(mt.samples(j or "", adopted and adopted.tick or 0, game.tick)) do
			if not x.gone and x.y < 2500 then
				after = after + 1
			end
		end
		ctx.expect(after > 0, "the destination samples under j")
	end)
end)

--- trains_handoff_game_test.lua:17-26: a train edge on sp3b with a scripted partner.
local function live(ctx, at, id, y, st)
	ctx.at(at, function()
		seams.edge(id, y, { { cid = "t1", type = "train", pos = 10, width = 6, params = { dir = "ab", layer = "ground" } } })
	end)
	ctx.at(at + 1, function()
		seams.partner(id, "t1", st)
		seams.track(id, "t1", 150)
	end)
end

t.case("crossing (UE): a rejected crossing keeps the source's journey and sends no mm.adopt (§13)", function(ctx)
	if not control.ue then
		return
	end
	local id, j, tid = "mm-rej", nil, nil
	live(ctx, 1000, id, 50000, { ready = true })
	ctx.at(1020, function()
		seams.add(id, "t1", { layout = "LC", at = 40, next = "MM NEXT", speed = 1 })
	end)
	for k = 1030, 1240, 10 do
		ctx.at(k, function()
			local tr = seams.trains(id, "t1")[1]
			if tr and not j then
				j, tid = by_train(tr), tr.id
			end
		end)
	end
	ctx.at(1250, function()
		local ep = seams.endpoint(id, "t1")
		ctx.expect(ep.data.held ~= nil, "captured")
		if ep.data.held then
			local seq = ep.tx.ab.inflight.seq
			seams.lane(id, { k = "u.reply", cid = "t1", dir = "ab", seq = seq, outcome = "reject", w = seq })
			seams.partner(id, "t1", { ready = true, w = 1 })
		end
	end)
	ctx.at(1260, function()
		local tr = seams.trains(id, "t1")[1]
		ctx.expect(j ~= nil, "the train had a journey before its capture")
		ctx.expect(tr ~= nil and tr.id == tid and by_train(tr) == j, "the restored train keeps its journey")
		ctx.expect(#mt.msgs("mm.adopt", 0, game.tick, function(m) return m.j == j end) == 0, "no mm.adopt")
	end)
end)

t.case("movers: a train at speed is read again every core.next_read ticks, so its polls stay within core.STEP tiles and a tick apart; a "
	.. "stopped one leaves the wheel with one zero-velocity sample (plan G Task 1)", function(ctx)
	local G, j, at
	local polls = {} -- the tick and x of each poll, as the movers' pt and px show it
	ctx.at(2910, function()
		G = mt.train(S, 1, 1000, "L")
	end)
	each(ctx, 2911, 2979, function(k)
		G.speed = 1
		j = j or by_train(G)
		local m = storage.minimap.movers[j or ""]
		if k >= 2940 and m and m.pt and m.pt ~= (polls[#polls] or {}).t then
			polls[#polls + 1] = { t = m.pt, x = m.px }
		end
	end)
	ctx.at(2980, function()
		ctx.expect(j ~= nil and (storage.minimap.fast or {})[j] ~= nil, "on the wheel while it runs")
		ctx.expect(#polls >= 8, "polled often, got " .. #polls .. " polls in 40 ticks")
		for i = 2, #polls do
			ctx.expect(polls[i].x - polls[i - 1].x <= core.STEP + 1, "polls " .. (polls[i].x - polls[i - 1].x) .. " tiles apart at " .. polls[i].t)
		end
		G.speed = 0
		at = game.tick
	end)
	ctx.at(2995, function()
		ctx.expect((storage.minimap.fast or {})[j or ""] == nil, "off the wheel once stopped")
		local stop = mt.samples(j or "", at, game.tick)
		ctx.expect(#stop == 1 and stop[1].vx == 0 and stop[1].vy == 0, "one zero-velocity sample, got " .. #stop)
	end)
end)
