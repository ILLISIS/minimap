-- Chart tags (spec §6.4, K18) and recipes (§6.6, K17): each change sends the new state, and the controller closes the
-- old. The resync's tag pass (§6.7 step 3) and its machine queue, sent core.MACHINES a tick (steps 5–6, K33), are here.
local core = require("modules/minimap/capture_core")
local tick = require("modules/minimap/tick")

local overlays = {}

local MACHINE = { ["assembling-machine"] = true, furnace = true }

--- Whether the chunk under position is captured (K3, K32).
local function captured(st, surface, position)
	return core.captured(st.tile, st.bounds, surface.name, math.floor(position.x / 32), math.floor(position.y / 32))
end

--- §6.4: a tag's new state, or { s, f, n } on removal, for captured forces and chunks. Returns true when it sent one.
--- icon is "<signal type>/<name>" (a SignalID reads type nil for an item), or "" without one.
function overlays.on_tag(e)
	local st = storage.minimap
	if not (st and st.configured and st.forces[e.force.index]) then
		return false
	end
	local tag = e.tag
	local surface, p = tag.surface, tag.position
	if not captured(st, surface, p) then
		return false
	end
	local msg = { type = "mm.tag", s = surface.name, f = e.force.name, n = tag.tag_number }
	if e.name ~= defines.events.on_chart_tag_removed then
		local icon = tag.icon
		msg.x, msg.y, msg.text = p.x, p.y, tag.text
		msg.icon = icon and icon.name and ((icon.type or "item") .. "/" .. icon.name) or ""
	end
	tick.send(msg)
	return true
end

--- A force's tags on a surface. The game tests replace it: headless has no charted chunk to hold a tag.
function overlays.find_tags(force, surface)
	return force.find_chart_tags(surface)
end

--- §6.7 step 3: every tag of every captured force on a captured chunk.
function overlays.resync_tags(st)
	for fi in pairs(st.forces) do
		local force = game.forces[fi]
		for _, surface in pairs(game.surfaces) do
			for _, tag in pairs(overlays.find_tags(force, surface)) do
				if overlays.on_tag{ name = defines.events.on_chart_tag_added, force = force, tag = tag } then
					st.resync.tags = st.resync.tags + 1
				end
			end
		end
	end
end

--- A prototype's name, from a RecipeID or QualityID read (a name, or an object with one).
local function id(v)
	return type(v) == "string" and v or v.name
end

--- §6.6: a machine's recipe and quality, from get_recipe() or, idle, a furnace's previous_recipe. Without either it
--- sends { s, f, u }, which closes the open version. The machine is registered (the same number every time, [api]),
--- so its destruction sends { s, f, u } too (C2). No dedupe here: the controller drops repeats (§8.9).
function overlays.send(st, e)
	local s, f, u = e.surface.name, e.force.name, e.unit_number
	local msg = { type = "mm.recipe", s = s, f = f, u = u }
	local recipe, quality = e.get_recipe()
	if recipe then
		msg.r, msg.q = recipe.name, quality and quality.name or "normal"
	elseif e.type == "furnace" and e.previous_recipe then
		msg.r, msg.q = id(e.previous_recipe.name), id(e.previous_recipe.quality)
	end
	if msg.r then
		msg.x, msg.y = e.position.x, e.position.y
	end
	st.reg[script.register_on_object_destroyed(e)] = { s = s, f = f, u = u }
	tick.send(msg)
end

--- §6.6's hooks (M7): a build's entity, a paste's destination, a closed GUI's entity. One type read for anything else.
function overlays.on_entity(e)
	local entity = e.entity or e.destination
	if not (entity and entity.valid and MACHINE[entity.type]) then
		return
	end
	local st = storage.minimap
	if not (st and st.configured and st.forces[entity.force.index] and captured(st, entity.surface, entity.position)) then
		return
	end
	overlays.send(st, entity)
end

--- A machine's registration fired: it is gone (C2).
function overlays.removed(v)
	tick.send{ type = "mm.recipe", s = v.s, f = v.f, u = v.u }
end

--- §6.7 step 5: a forced chunk's machines join the resync's queue. ponytail: a machine across two chunks is sent twice;
--- the controller drops the repeat (§8.9).
function overlays.machines_in(st, surface, force, pos)
	local x, y = pos.x * 32, pos.y * 32
	for _, e in pairs(surface.find_entities_filtered{ area = { { x, y }, { x + 32, y + 32 } },
		type = { "assembling-machine", "furnace" }, force = force }) do
		core.push(st.machines, e)
		if st.resync then
			st.resync.machines = st.resync.machines + 1
		end
	end
end

--- §6.10 step 3 (K33): at most core.MACHINES of the resync's machines a tick.
function overlays.step(st)
	for _ = 1, core.MACHINES do
		local e = core.pop(st.machines)
		if not e then
			return
		end
		if e.valid then
			overlays.send(st, e)
		end
	end
end

return overlays
