-- The outbox (spec §6.10, K34): handlers append messages during a tick, and control.lua's on_tick flushes them as
-- { tick, msgs } lines under 3,500 bytes, in Clusterio's IPC frame. The per-tick steps live in control.lua, which
-- requires every module, so no module requires its caller (plan ruling 4).
local core = require("modules/minimap/capture_core")

local tick = {}

-- ponytail: K2, as terrain.lua's `last`: the outbox, this tick's mm.move per surface and the count of dropped messages
-- only feed printed lines, so they are file-locals, never storage. A joining client's differ only in its own stdout.
local outbox, moves, oversize = {}, {}, 0

-- ponytail: Clusterio's frame, pinned: clusterio/packages/host/modules/clusterio/api.lua:33-34 at 2efb53aa prints
-- "\f$ipc:" .. channel .. "?j" .. data, as UE's bridge does (universal_edges/module/runtime/bridge.lua:47-54,96-98).
-- send_json is never called: it encodes the batch again, and on a client with a fuller batch a line could cross 4,000
-- bytes, take the file path and bump a saved counter, which desyncs that client (spec §6.10, REV M-4). On a Clusterio
-- upgrade, re-check api.lua's frame and its channel escaping, which leaves "minimap:out" unchanged.
local FRAME = "\f$ipc:minimap:out?j"

--- Queue one message for this tick's flush. Samples queued after it start a new mm.move, so every message keeps its
--- place in the order: a resync's samples always follow its mm.surfaces (plan ruling 26).
function tick.send(msg)
	outbox[#outbox + 1] = msg
	moves = {}
end

--- Add a sample, or { j, gone = true }, to this tick's mm.move for the surface named s: at most core.MOVE_MAX a
--- message, so even 200-byte names keep a message well under a line, and a resync's thousand movers fit (ruling 9).
function tick.move(s, sample)
	local m = moves[s]
	if not m or #m.m >= core.MOVE_MAX then
		m = { type = "mm.move", s = s, m = {} }
		moves[s] = m
		outbox[#outbox + 1] = m
	end
	m.m[#m.m + 1] = sample
end

--- Print one line. The game tests wrap it to read what was printed (harness/lua/minimap_test.lua).
function tick.emit(line)
	print(line)
end

--- Messages dropped since load for being too big for a line (K34; none is possible, §7.1).
function tick.oversize()
	return oversize
end

--- §6.10 step 6: encode each message once, cut the batch byte-exactly, print the lines.
function tick.flush(t)
	if #outbox == 0 then
		return
	end
	local parts = {}
	for i, msg in ipairs(outbox) do
		parts[i] = helpers.table_to_json(msg)
	end
	outbox, moves = {}, {}
	local lines, dropped = core.cut(t, parts, core.LIMIT)
	oversize = oversize + dropped
	for _, line in ipairs(lines) do
		tick.emit(FRAME .. line)
	end
end

return tick
