local t = require("modules/v2_test/testlib")
local mt = require("modules/v2_test/minimap")
local control = require("modules/minimap/control")
local core = require("modules/minimap/capture_core")
local clusterio_api = require("modules/clusterio/api")
local compat = require("modules/clusterio/compat")

-- Minimap plan A Task 3 (spec §16.3 Terrain and Resync) on the lab surfaces mm-a, mm-b, mm-tile and mm-r. A step runs
-- after the minimap's on_tick: what it queues is taken, and printed, from the next tick. Windows use game.tick.

--- The mm.chunk messages printed at ticks [from, to] for surface s, and chunk (x, y) when given.
local function chunks(from, to, s, x, y)
	return mt.msgs("mm.chunk", from, to, function(m)
		return m.s == s and (x == nil or (m.x == x and m.y == y))
	end)
end

local function queued()
	return core.size(storage.minimap.queue)
end

t.case("terrain: nothing is captured before this boot's config (§6.1)", function(ctx)
	ctx.at(2, function()
		mt.surface("mm-a", -64, 191, -64, 191)
		mt.surface("mm-b", -64, 63, -64, 63)
		mt.surface("mm-tile", -64, 127, -64, 63)
		mt.surface("mm-r", 0, 95, 0, 31)
	end)
	ctx.at(14, function()
		mt.chart("mm-a", 1, 1, mt.solid(1))
		mm_rt.seam.force("player") -- so only the missing config can stop the handler
		local before = queued()
		mm_rt.seam.charted("mm-a", "player", 1, 1)
		ctx.expect(queued() == before, "the handler took nothing before the config")
	end)
	ctx.at(20, function()
		mt.config()
	end)
end)

t.case("terrain: a changed chart sends one mm.chunk; a byte-identical re-chart sends and logs nothing (§6.2, K2)",
	function(ctx)
		local at
		ctx.at(30, function()
			at = game.tick
			mt.chart("mm-a", 0, 0, mt.solid(0x1234))
			mm_rt.seam.charted("mm-a", "player", 0, 0)
		end)
		ctx.at(32, function()
			local got = chunks(at, game.tick, "mm-a", 0, 0)
			ctx.expect(#got == 1, "one mm.chunk, got " .. #got)
			ctx.expect(got[1] ~= nil and got[1].f == "player" and helpers.decode_string(got[1].d) == mt.solid(0x1234),
				"the chart, deflated, for the player force")
		end)
		ctx.at(40, function()
			at = game.tick
			mm_rt.seam.charted("mm-a", "player", 0, 0)
		end)
		ctx.at(44, function()
			ctx.expect(#chunks(at, game.tick, "mm-a", 0, 0) == 0, "an identical re-chart sends nothing")
			ctx.expect(#mt.msgs("trace", at, game.tick) == 0, "and logs nothing")
		end)
	end)

t.case("terrain: other surfaces are captured anywhere; the tile clips its own; equal chunks on two surfaces are two "
	.. "messages; a config without a tile clips nothing (§6.1, K3, K32, C6)", function(ctx)
	local at
	ctx.at(50, function()
		at = game.tick
		local list = { { "mm-a", 100, -100 }, { "mm-b", 0, 0 }, { "mm-tile", 0, 0 }, { "mm-tile", -1, -1 },
			{ "mm-tile", 1, 0 }, { "mm-tile", 0, 1 } }
		for i, c in ipairs(list) do
			mt.chart(c[1], c[2], c[3], mt.solid(300 + i))
			mm_rt.seam.charted(c[1], "player", c[2], c[3])
		end
	end)
	ctx.at(60, function()
		local now = game.tick
		ctx.expect(#chunks(at, now, "mm-a", 100, -100) == 1, "a far chunk of a surface without a tile")
		ctx.expect(#chunks(at, now, "mm-b", 0, 0) == 1, "mm-b's (0, 0), apart from mm-a's")
		ctx.expect(#chunks(at, now, "mm-tile", 0, 0) == 1 and #chunks(at, now, "mm-tile", -1, -1) == 1, "inside the tile")
		ctx.expect(#chunks(at, now, "mm-tile", 1, 0) == 0 and #chunks(at, now, "mm-tile", 0, 1) == 0, "outside the tile")
	end)
	ctx.at(3700, function()
		at = game.tick
		mm_rt.config("{}")
		mm_rt.seam.charted("mm-tile", "player", 1, 0)
	end)
	ctx.at(3704, function()
		ctx.expect(#chunks(at, game.tick, "mm-tile", 1, 0) == 1, "without a tile, mm-tile is captured whole")
		mt.config()
	end)
end)

t.case("terrain: a force without players sends nothing (M7)", function(ctx)
	local at
	ctx.at(70, function()
		at = game.tick
		mt.chart("mm-a", 3, 3, mt.solid(7), "enemy")
		mm_rt.seam.charted("mm-a", "enemy", 3, 3)
	end)
	ctx.at(74, function()
		ctx.expect(#mt.msgs("mm.chunk", at, game.tick, function(m) return m.f == "enemy" end) == 0, "nothing for enemy")
	end)
end)

t.case("terrain: a deleted chunk sends its mm.chunk without d (§6.2 step 4)", function(ctx)
	local at
	ctx.at(80, function()
		mt.chart("mm-a", 5, 5, mt.solid(8))
		mm_rt.seam.charted("mm-a", "player", 5, 5)
	end)
	ctx.at(84, function()
		at = game.tick
		mt.chart("mm-a", 5, 5, nil)
		game.surfaces["mm-a"].delete_chunk({ 5, 5 })
		-- a chunk whose chart was never sent (`last` nil) still reports its deletion
		game.surfaces["mm-a"].delete_chunk({ 4, 4 })
	end)
	ctx.at(95, function()
		local got = chunks(at, game.tick, "mm-a", 5, 5)
		ctx.expect(#got == 1 and got[1].d == nil, "one mm.chunk, without d; got " .. #got)
		local never = chunks(at, game.tick, "mm-a", 4, 4)
		ctx.expect(#never == 1 and never[1].d == nil, "a never-sent chunk too; got " .. #never)
	end)
end)

t.case("terrain: at most 2 chart items a tick (K4)", function(ctx)
	local at
	ctx.at(100, function()
		at = game.tick
		for x = 10, 19 do
			mt.chart("mm-b", x, 0, mt.solid(x))
			mm_rt.seam.charted("mm-b", "player", x, 0)
		end
	end)
	ctx.at(110, function()
		local per, n = {}, 0
		for _, m in ipairs(mt.msgs("mm.chunk", at, game.tick)) do
			per[m.tick] = (per[m.tick] or 0) + 1
			if m.s == "mm-b" and m.y == 0 and m.x >= 10 then
				n = n + 1
			end
		end
		ctx.expect(n == 10, "all ten sent, got " .. n)
		for at_tick, k in pairs(per) do
			ctx.expect(k <= 2, k .. " chunks at tick " .. at_tick)
		end
	end)
end)

t.case("terrain: no line reaches 3,500 bytes, an incompressible chart included, and none takes Clusterio's file path "
	.. "(K34)", function(ctx)
	local files, at
	ctx.at(20, function()
		files = compat.script_data.clusterio_file_no or 0
	end)
	ctx.at(120, function()
		at = game.tick
		mt.chart("mm-b", 30, 30, mt.noise(7))
		mt.chart("mm-b", 31, 30, mt.noise(8))
		mm_rt.seam.charted("mm-b", "player", 30, 30)
		mm_rt.seam.charted("mm-b", "player", 31, 30)
	end)
	ctx.at(124, function()
		local lines, intact = {}, 0
		for _, b in ipairs(mt.batches) do
			if b.data.tick >= at then
				for _, m in ipairs(b.data.msgs) do
					if m.type == "mm.chunk" and m.s == "mm-b" and m.y == 30 and m.x >= 30 then
						lines[#lines + 1] = b
						intact = intact + (helpers.decode_string(m.d) == mt.noise(m.x - 23) and 1 or 0)
					end
				end
			end
		end
		ctx.expect(#lines == 2 and lines[1] ~= lines[2], "two noise charts of one tick are two lines, got " .. #lines)
		ctx.expect(intact == 2, "both charts intact")
		for _, b in ipairs(lines) do
			ctx.expect(b.bytes < 3500 and b.data.tick ~= nil, "a line under 3,500 bytes with its tick: " .. b.bytes)
		end
		local got = chunks(at, game.tick, "mm-b", 30, 30)
		ctx.expect(#got == 1 and helpers.decode_string(got[1].d) == mt.noise(7), "the noise chart, intact")
		ctx.expect(got[1] ~= nil and #got[1].d > 2000, "it deflated badly: " .. (got[1] and #got[1].d or 0) .. " bytes")
	end)
	ctx.at(3840, function()
		local biggest = 0
		for _, b in ipairs(mt.batches) do
			biggest = math.max(biggest, b.bytes)
		end
		ctx.expect(biggest < 3500, "the biggest line is " .. biggest .. " bytes")
		-- UE's bridge sends a line of 4,000 bytes or more through send_json, which bumps this counter
		-- (universal_edges/module/runtime/bridge.lua:97-101), so it is checked standalone only.
		if ue_rt == nil then
			ctx.expect((compat.script_data.clusterio_file_no or 0) == files, "Clusterio's file counter never moved")
		end
	end)
end)

t.case("resync: the surfaces, then only charted chunks, sent though unchanged, then mm.resynced (§6.7, K5, K33)",
	function(ctx)
		local at
		ctx.at(400, function()
			mt.chart("mm-r", 0, 0, mt.solid(9))
			mt.chart("mm-r", 1, 0, mt.solid(10))
			mm_rt.seam.charted("mm-r", "player", 0, 0)
			mm_rt.seam.charted("mm-r", "player", 1, 0)
		end)
		ctx.at(410, function()
			at = game.tick
			mm_rt.resync("mm.r1")
		end)
		ctx.at(430, function()
			local now = game.tick
			local tiles = {}
			for _, m in ipairs(mt.msgs("mm.surfaces", at, now)) do
				for _, s in ipairs(m.list) do
					tiles[s.name] = s.tile
				end
			end
			ctx.expect(tiles["mm-tile"] == true and tiles["mm-r"] == false and tiles.nauvis == false,
				"mm.surfaces names every surface, and the tile's")
			local r0, r1 = chunks(at, now, "mm-r", 0, 0), chunks(at, now, "mm-r", 1, 0)
			ctx.expect(#r0 == 1 and #r1 == 1, "both charted chunks again, though unchanged")
			ctx.expect(#chunks(at, now, "mm-r", 2, 0) == 0, "never the uncharted one")
			local done = mt.msgs("mm.resynced", at, now, function(m) return m.trace == "mm.r1" end)
			ctx.expect(#done == 1, "one mm.resynced, got " .. #done)
			if done[1] and r0[1] and r1[1] then
				ctx.expect(done[1].tick >= r0[1].tick and done[1].tick >= r1[1].tick, "after the last chunk")
				local first = mt.msgs("mm.surfaces", at, now)[1]
				ctx.expect(first ~= nil and first.tick <= math.min(r0[1].tick, r1[1].tick), "mm.surfaces comes first")
				ctx.expect(done[1].counts.chunks >= 2 and done[1].counts.drops == 0, "counts")
			end
		end)
	end)

t.case("resync: a second resync before the first ends completes once, under its own trace (Review Focus 4)",
	function(ctx)
		local at
		ctx.at(450, function()
			at = game.tick
			mm_rt.resync("mm.r2")
			mm_rt.resync("mm.r3")
		end)
		ctx.at(470, function()
			local done = mt.msgs("mm.resynced", at, game.tick)
			ctx.expect(#done == 1 and done[1].trace == "mm.r3", "only mm.r3 completes")
			local all = chunks(at, game.tick, "mm-r")
			ctx.expect(done[1] ~= nil and #all > 0 and all[#all].tick <= done[1].tick, "after its own last chunk")
		end)
	end)

t.case("terrain: nothing after on_server_startup until the next config (§6.1)", function(ctx)
	ctx.at(3860, function()
		-- the minimap's own handler, called directly: raising the event would reset UE's sides in the plugins pass
		control.events[clusterio_api.events.on_server_startup]()
		mt.chart("mm-a", 1, 2, mt.solid(11))
		local before = queued()
		mm_rt.seam.charted("mm-a", "player", 1, 2)
		ctx.expect(storage.minimap.configured == false and queued() == before, "unconfigured: nothing queued")
	end)
	ctx.at(3863, function()
		ctx.expect(#chunks(game.tick - 3, game.tick, "mm-a", 1, 2) == 0, "and nothing printed")
	end)
end)
