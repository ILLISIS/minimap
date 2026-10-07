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
		mm_rt.seam.force("player") -- the config re-read the forces with players
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
		ctx.at(445, function() -- the walk takes ticks (K33)
			local now = game.tick
			local tiles = {}
			for _, m in ipairs(mt.msgs("mm.surfaces", at, now, function(m) return not m.created end)) do
				for _, s in ipairs(m.list) do
					tiles[s.name] = s.tile
				end
			end
			-- §22.1: Nauvis is a planet the test tile's (empty) exclude list doesn't name, so it is tiled too
			ctx.expect(tiles["mm-tile"] == true and tiles["mm-r"] == false and tiles.nauvis == true,
				"mm.surfaces names every surface, and the tile's and the planets' as tiled")
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
		end)
		ctx.at(452, function() -- r2's walk is under way (plan ruling 16)
			mm_rt.resync("mm.r3")
		end)
		ctx.at(495, function()
			local done = mt.msgs("mm.resynced", at, game.tick)
			ctx.expect(#done == 1 and done[1].trace == "mm.r3", "only mm.r3 completes")
			local all = chunks(at, game.tick, "mm-r")
			ctx.expect(done[1] ~= nil and #all > 0 and all[#all].tick <= done[1].tick, "after its own last chunk")
		end)
	end)

t.case("resync: the walk spreads over ticks, at most core.RESYNC_CHUNKS charted chunks a tick, and covers chunks "
	.. "generated after the boxes were made (K33; owner, 2026-10-05)", function(ctx)
	local at, last
	ctx.at(3000, function()
		mt.surface("mm-w", 0, 319, 0, 319) -- chunks 0 .. 10 each way, made after the config's boxes
		mt.surface("mm-w", 960, 960, 0, 0) -- and chunk 30 east (Factorio generates a few past it)
		for x = 0, 7 do
			for y = 0, 4 do
				mt.chart("mm-w", x, y, mt.solid(20))
			end
		end
		-- the tile's surface walks its bounds (chunks -1 .. 0 each way), not its rows; so does a planet (§22.1): Nauvis's
		-- (1, 1), outside the bounds, is never walked
		mt.chart("mm-tile", -1, -1, mt.solid(22))
		mt.chart("mm-tile", 0, 0, mt.solid(22))
		mt.chart("mm-tile", 1, 0, mt.solid(22))
		mt.chart("nauvis", 0, 0, mt.solid(23))
		mt.chart("nauvis", 1, 1, mt.solid(23))
	end)
	ctx.at(3002, function()
		local b = storage.minimap.boxes[game.surfaces["mm-w"].index]
		local row0 = b and b.rows[0]
		ctx.expect(row0 ~= nil and row0[1] <= 0 and row0[2] >= 31 and #b.ys >= 11,
			"on_chunk_generated grew mm-w's rows: row 0 to chunk 30, got " .. (row0 and row0[1] .. ".." .. row0[2] or "none")
			.. " over " .. (b and #b.ys or 0) .. " rows")
		last = row0 and row0[2] - 1 or 30
		mt.chart("mm-w", last, 0, mt.solid(21)) -- row 0's last position: a walk that skips a row's end misses it
		at = game.tick
		local before = queued()
		mm_rt.resync("mm.w1")
		ctx.expect(queued() == before and storage.minimap.resync.chunks == 0, "nothing queued in the resync's own tick")
	end)
	for k = 1, 3 do
		ctx.at(3002 + k, function()
			local r = storage.minimap.resync
			ctx.expect(r ~= nil and r.chunks <= k * core.RESYNC_CHUNKS,
				"at most " .. k * core.RESYNC_CHUNKS .. " chunks after " .. k .. " ticks, got " .. (r and r.chunks or "none"))
		end)
	end
	ctx.at(3600, function()
		local now = game.tick
		local done = mt.msgs("mm.resynced", at, now, function(m) return m.trace == "mm.w1" end)
		ctx.expect(#done == 1 and done[1].counts.chunks >= 41, "mm.resynced, counting mm-w's 41 charted chunks")
		local seen = {}
		for _, m in ipairs(chunks(at, now, "mm-w")) do
			seen[m.x .. "," .. m.y] = true
		end
		local n = 0
		for _ in pairs(seen) do
			n = n + 1
		end
		ctx.expect(n == 41 and seen[last .. ",0"], "every charted chunk of mm-w, row 0's last included, got " .. n)
		ctx.expect(#chunks(at, now, "mm-tile", -1, -1) == 1 and #chunks(at, now, "mm-tile", 0, 0) == 1
			and #chunks(at, now, "mm-tile", 1, 0) == 0, "the tile's bounds: (-1, -1) and (0, 0), not (1, 0)")
		ctx.expect(#chunks(at, now, "nauvis", 0, 0) == 1 and #chunks(at, now, "nauvis", 1, 1) == 0,
			"a planet's walk is the tile's bounds too: Nauvis's (0, 0), not (1, 1) (§22.1)")
		mt.chart("nauvis", 0, 0, nil)
		mt.chart("nauvis", 1, 1, nil)
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

t.case("terrain: a config re-reads the forces with players (M7)", function(ctx)
	ctx.at(3710, function()
		storage.minimap.forces[9999] = true
		mt.config()
		ctx.expect(storage.minimap.forces[9999] == nil, "a stale force index is gone after the config")
		ctx.expect(storage.minimap.forces[game.forces.player.index] == true, "a seam-marked force survives a config")
	end)
end)

t.case("terrain: a new surface on a deleted surface's index is sent a chunk equal to the deleted one's (M2 review)",
	function(ctx)
		local at, si
		ctx.at(3712, function()
			local s = mt.surface("mm-x", 0, 31, 0, 31)
			si = s.index
			mt.chart("mm-x", 0, 0, mt.solid(0x2222))
			mm_rt.seam.charted("mm-x", "player", 0, 0)
		end)
		ctx.at(3715, function()
			ctx.expect(#chunks(0, game.tick, "mm-x", 0, 0) == 1, "mm-x's chunk was sent")
			game.delete_surface("mm-x")
		end)
		ctx.at(3720, function()
			local s = mt.surface("mm-y", 0, 31, 0, 31)
			ctx.expect(s.index == si, "the engine reused index " .. si .. ", got " .. s.index)
			mt.chart("mm-y", 0, 0, mt.solid(0x2222))
			at = game.tick
			mm_rt.seam.charted("mm-y", "player", 0, 0)
		end)
		ctx.at(3724, function()
			ctx.expect(#chunks(at, game.tick, "mm-y", 0, 0) == 1, "the same bytes on the reused index are sent")
		end)
	end)

t.case("terrain: a planet is clipped to the tile's bounds like the tile's surface, unless the tile's exclude list names "
	.. "it (§22.1, M14)", function(ctx)
	local at
	ctx.at(3730, function()
		at = game.tick
		mt.chart("nauvis", 0, 0, mt.solid(0x3131))
		mt.chart("nauvis", 1, 1, mt.solid(0x3232))
		mm_rt.seam.charted("nauvis", "player", 0, 0)
		mm_rt.seam.charted("nauvis", "player", 1, 1)
	end)
	ctx.at(3734, function()
		ctx.expect(game.surfaces.nauvis.planet ~= nil, "Nauvis's surface has its planet")
		ctx.expect(#chunks(at, game.tick, "nauvis", 0, 0) == 1, "Nauvis's (0, 0), inside the tile's bounds, is sent")
		ctx.expect(#chunks(at, game.tick, "nauvis", 1, 1) == 0, "Nauvis's (1, 1), outside them, isn't")
		local tile = {}
		for k, v in pairs(mt.TILE) do
			tile[k] = v
		end
		tile.exclude = { "nauvis" }
		mm_rt.config(helpers.table_to_json({ tile = tile }))
		mm_rt.seam.force("player") -- the config re-read the forces with players
		at = game.tick
		mm_rt.seam.charted("nauvis", "player", 1, 1)
	end)
	ctx.at(3738, function()
		ctx.expect(#chunks(at, game.tick, "nauvis", 1, 1) == 1, "excluded, Nauvis is captured whole")
		mt.config()
		mt.chart("nauvis", 0, 0, nil)
		mt.chart("nauvis", 1, 1, nil)
	end)
end)

t.case("terrain: a surface made mid-game is sent at once, alone, in an mm.surfaces flagged created (§22.1, §6.9; plan "
	.. "F ruling P3)", function(ctx)
	local at
	ctx.at(3740, function()
		at = game.tick
		game.create_surface("mm-n")
	end)
	ctx.at(3742, function()
		local got = mt.msgs("mm.surfaces", at, game.tick, function(m) return m.created and m.list[1].name == "mm-n" end)
		ctx.expect(#got == 1 and #got[1].list == 1 and got[1].list[1].tile == false,
			"one mm.surfaces with mm-n alone, untiled (a lab surface is no planet), got " .. #got)
	end)
end)
