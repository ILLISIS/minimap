local t = require("modules/v2_test/testlib")
local mt = require("modules/v2_test/minimap")
local overlays = require("modules/minimap/overlays")

-- Minimap plan A Task 5 (spec §16.3 Tags and Recipes, and the resync's tags and machines) on lab surfaces mm-o and
-- mm-q, and mm-tile for the clip; ticks 2000–2501. A chart tag needs a charted chunk ([api] LuaForce.add_chart_tag) and
-- a paste or a GUI close needs a player, which headless lacks: those cases hand overlays.on_tag and overlays.on_entity
-- the event tables the game would (plan ruling 14).

local function tag_event(name, force, tag)
	return { name = defines.events[name], force = game.forces[force], tag = tag }
end

local function recipes(from, to, u)
	return mt.msgs("mm.recipe", from, to, function(m) return m.u == u end)
end

t.case("tags: added, modified and removed send the tag's new state, its text intact; a removal sends { s, f, n } "
	.. "(§6.4, K18, Review Focus 3)", function(ctx)
	local at
	local text = 'a "q" \\ b\nü ✓'
	ctx.at(20, function()
		mt.config()
	end)
	ctx.at(2000, function()
		at = game.tick
		local s = mt.surface("mm-o", 0, 95, 0, 95)
		local tag = { valid = true, tag_number = 7, surface = s, position = { x = 10.5, y = 20 },
			icon = { type = "virtual", name = "signal-A" }, text = "hi" }
		overlays.on_tag(tag_event("on_chart_tag_added", "player", tag))
		tag.text, tag.icon = text, nil
		overlays.on_tag(tag_event("on_chart_tag_modified", "player", tag))
		tag.icon = { name = "iron-plate" }
		overlays.on_tag(tag_event("on_chart_tag_modified", "player", tag))
		overlays.on_tag(tag_event("on_chart_tag_removed", "player", tag))
	end)
	ctx.at(2002, function()
		local got = mt.msgs("mm.tag", at, game.tick, function(m) return m.s == "mm-o" and m.n == 7 end)
		ctx.expect(#got == 4, "four states, got " .. #got)
		if #got == 4 then
			ctx.expect(got[1].x == 10.5 and got[1].y == 20 and got[1].icon == "virtual/signal-A" and got[1].text == "hi"
				and got[1].f == "player", "added")
			ctx.expect(got[2].icon == "" and got[2].text == text, "modified: no icon, and the text byte for byte")
			ctx.expect(got[3].icon == "item/iron-plate", "an item icon, whose type reads as nil")
			ctx.expect(got[4].x == nil and got[4].icon == nil and got[4].text == nil, "removed: { s, f, n }")
		end
	end)
end)

t.case("tags: a force without players, and a tag outside the tile, send nothing (M7, K32)", function(ctx)
	local at
	ctx.at(2010, function()
		at = game.tick
		local o = mt.surface("mm-o", 0, 95, 0, 95)
		local tile = mt.surface("mm-tile", -64, 127, -64, 63)
		overlays.on_tag(tag_event("on_chart_tag_added", "enemy", { tag_number = 8, surface = o,
			position = { x = 1, y = 1 }, text = "" }))
		overlays.on_tag(tag_event("on_chart_tag_added", "player", { tag_number = 9, surface = tile,
			position = { x = 40, y = 0 }, text = "" }))
		overlays.on_tag(tag_event("on_chart_tag_added", "player", { tag_number = 10, surface = tile,
			position = { x = 10, y = 10 }, text = "" }))
	end)
	ctx.at(2012, function()
		local got = {}
		for _, m in ipairs(mt.msgs("mm.tag", at, game.tick)) do
			got[m.n] = true
		end
		ctx.expect(not got[8], "not for enemy")
		ctx.expect(not got[9], "not outside the tile")
		ctx.expect(got[10] == true, "inside the tile")
	end)
end)

t.case("recipes: a build, a paste and a closed GUI send the recipe and its quality; no recipe, and destruction, send "
	.. "{ s, f, u } (§6.6, K17, C1–C3)", function(ctx)
	local a, u, ins, at
	ctx.at(2100, function()
		at = game.tick
		local s = mt.surface("mm-o", 0, 95, 0, 95)
		-- a quality a force hasn't unlocked may be refused; unlocking is harmless to every other case
		game.forces.player.unlock_quality("uncommon")
		game.forces.player.unlock_quality("rare")
		a = s.create_entity{ name = "assembling-machine-2", position = { 10.5, 10.5 }, force = "player",
			recipe = "iron-gear-wheel", raise_built = true }
		u = a.unit_number
		ins = s.create_entity{ name = "inserter", position = { 20.5, 10.5 }, force = "player", raise_built = true }
	end)
	ctx.at(2102, function()
		a.set_recipe("copper-cable", "uncommon")
		overlays.on_entity({ destination = a }) -- on_entity_settings_pasted
		a.set_recipe("iron-gear-wheel", "rare")
		overlays.on_entity({ entity = a }) -- on_gui_closed
		a.set_recipe(nil)
		overlays.on_entity({ entity = a })
	end)
	ctx.at(2104, function()
		local got = recipes(at, game.tick, u)
		ctx.expect(#got == 4, "four states, got " .. #got)
		if #got == 4 then
			ctx.expect(got[1].r == "iron-gear-wheel" and got[1].q == "normal" and got[1].x == 10.5 and got[1].y == 10.5
				and got[1].s == "mm-o" and got[1].f == "player", "built (script_raised_built)")
			ctx.expect(got[2].r == "copper-cable" and got[2].q == "uncommon", "pasted")
			ctx.expect(got[3].r == "iron-gear-wheel" and got[3].q == "rare", "a closed GUI, with quality")
			ctx.expect(got[4].r == nil and got[4].x == nil, "no recipe: { s, f, u }")
		end
		ctx.expect(#recipes(at, game.tick, ins.unit_number) == 0, "an inserter is no machine")
		at = game.tick
		a.destroy()
	end)
	ctx.at(2110, function()
		local got = recipes(at, game.tick, u)
		ctx.expect(#got == 1 and got[1].r == nil, "destroyed: { s, f, u } (C2)")
	end)
end)

t.case("recipes: an idle furnace reports the recipe it last smelted (§6.6)", function(ctx)
	local f, at
	ctx.at(2100, function()
		f = mt.surface("mm-o", 0, 95, 0, 95).create_entity{ name = "stone-furnace", position = { 30, 10 },
			force = "player" }
		f.insert{ name = "iron-ore", count = 1 }
		f.get_fuel_inventory().insert{ name = "coal", count = 5 }
	end)
	ctx.at(2400, function()
		ctx.expect(f.get_output_inventory().get_item_count("iron-plate") == 1, "it smelted one plate")
		at = game.tick
		overlays.on_entity({ entity = f })
	end)
	ctx.at(2402, function()
		local got = recipes(at, game.tick, f.unit_number)
		ctx.expect(#got == 1 and got[1].r == "iron-plate", "iron-plate, from get_recipe or previous_recipe")
	end)
end)

t.case("resync: tags and recipes; at most 8 machines a tick over a chunk of 60 assemblers, then mm.resynced (§6.7 "
	.. "steps 3, 5–6; K33)", function(ctx)
	local real, at, units = overlays.find_tags, nil, {}
	ctx.at(2450, function()
		local q = mt.surface("mm-q", 0, 63, 0, 31)
		for i = 0, 9 do
			for k = 0, 5 do
				local e = q.create_entity{ name = "assembling-machine-1", position = { 1.5 + 3 * i, 1.5 + 3 * k },
					force = "player", recipe = "iron-gear-wheel" }
				units[e.unit_number] = true
			end
		end
		mt.chart("mm-q", 0, 0, mt.solid(42))
		local tag = { valid = true, tag_number = 70, surface = q, position = { x = 5, y = 5 }, text = "q" }
		overlays.find_tags = function(force, surface)
			if surface.name == "mm-q" and force.name == "player" then
				return { tag }
			end
			return real(force, surface)
		end
	end)
	ctx.at(2460, function()
		at = game.tick
		mm_rt.resync("mm.o1")
	end)
	ctx.at(2800, function() -- the walk takes ticks (K33): about 80 in the plugins pass
		local now, per, seen, n = game.tick, {}, {}, 0
		for _, m in ipairs(mt.msgs("mm.recipe", at, now)) do
			per[m.tick] = (per[m.tick] or 0) + 1
			if units[m.u] and not seen[m.u] then
				seen[m.u], n = true, n + 1
			end
		end
		ctx.expect(n == 60, "all 60 assemblers, got " .. n)
		local last = 0
		for at_tick, k in pairs(per) do
			ctx.expect(k <= 8, k .. " machines at tick " .. at_tick)
			last = math.max(last, at_tick)
		end
		ctx.expect(#mt.msgs("mm.tag", at, now, function(m) return m.n == 70 and m.s == "mm-q" end) == 1, "the tag")
		local done = mt.msgs("mm.resynced", at, now, function(m) return m.trace == "mm.o1" end)
		ctx.expect(#done == 1, "one mm.resynced")
		if done[1] then
			ctx.expect(done[1].tick >= last, "after the last machine")
			ctx.expect(done[1].counts.machines >= 60 and done[1].counts.tags >= 1, "counted")
		end
		overlays.find_tags = real
	end)
end)
