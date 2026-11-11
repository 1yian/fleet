local function path_of(entry)
	return tostring(entry.url or entry)
end

local snapshot = ya.sync(function()
	local selected = {}
	for _, file in pairs(cx.active.selected) do
		selected[#selected + 1] = path_of(file)
	end
	local hovered = cx.active.current.hovered
	if #selected == 0 and hovered then
		selected[1] = path_of(hovered)
	end
	local cut = {}
	if cx.yanked.is_cut then
		for _, file in pairs(cx.yanked) do
			cut[#cut + 1] = path_of(file)
		end
	end
	return { cwd = tostring(cx.active.current.cwd), selected = selected, cut = cut }
end)

local function named(args)
	local out = {}
	for key, value in pairs(args) do
		if type(key) == "string" then
			out[key] = value
		end
	end
	return out
end

local function targets(action, here)
	if action ~= "create" and action ~= "paste" and action ~= "link" then
		return here.selected
	end
	local list = { here.cwd }
	for _, url in ipairs(here.cut) do
		list[#list + 1] = url
	end
	return list
end

return {
	entry = function(_, job)
		local action = job.args[1]
		local checked = { "check" }
		for _, path in ipairs(targets(action, snapshot())) do
			checked[#checked + 1] = path
		end
		local output = Command(os.getenv("FLEET_FILES_BIN")):arg(checked):stderr(Command.PIPED):output()
		if output and output.status.success then
			ya.emit(action, named(job.args))
			return
		end
		local why = output and output.stderr or "the guard could not run"
		ya.notify({ title = "Guarded: " .. action .. " refused", content = why, timeout = 8, level = "warn" })
	end,
}
