local function path_of(entry)
	return tostring(entry.url or entry)
end

local function base_of(path)
	return path:match("([^/]+)/*$") or path
end

local function parent_of(path)
	local dir = path:match("^(.*)/[^/]+/*$")
	if dir == nil or dir == "" then
		return "/"
	end
	return dir
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
	local yanked = {}
	for _, file in pairs(cx.yanked) do
		yanked[#yanked + 1] = path_of(file)
	end
	return {
		cwd = tostring(cx.active.current.cwd),
		hovered = hovered and path_of(hovered) or nil,
		selected = selected,
		yanked = yanked,
		cut = cx.yanked.is_cut,
	}
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
	if action == "create" then
		return { here.cwd }
	end
	if action == "rename" then
		return { here.hovered }
	end
	if action ~= "paste" and action ~= "link" then
		return here.selected
	end
	local list = { here.cwd }
	for _, path in ipairs(here.yanked) do
		list[#list + 1] = here.cwd .. "/" .. base_of(path)
		if action == "paste" and here.cut then
			list[#list + 1] = path
		end
	end
	return list
end

local function run(verb, paths)
	local args = { verb }
	for _, path in ipairs(paths) do
		args[#args + 1] = path
	end
	local output = Command(os.getenv("FLEET_FILES_BIN")):arg(args):stderr(Command.PIPED):output()
	if output and output.status.success then
		return true
	end
	return false, output and output.stderr or "the guard could not run"
end

local function ask(title, value)
	local text, event = ya.input({ title = title, value = value, pos = { "top-center", y = 3, w = 50 } })
	if event == 1 and text ~= nil and text ~= "" then
		return text
	end
end

local function changed(verb, paths, shown)
	local ok, why = run(verb, paths)
	if ok then
		ya.emit("reveal", { (shown:gsub("/+$", "")) })
	end
	return ok, why
end

local function renamed(here)
	if here.hovered == nil then
		return true
	end
	local name = ask("Rename:", base_of(here.hovered))
	if name == nil or name == base_of(here.hovered) then
		return true
	end
	local to = parent_of(here.hovered) .. "/" .. name
	return changed("rename", { here.hovered, to }, to)
end

local function created(here)
	local name = ask("Create:", "")
	if name == nil then
		return true
	end
	local path = here.cwd .. "/" .. name
	return changed("create", { path }, path)
end

return {
	entry = function(_, job)
		local action = job.args[1]
		local here = snapshot()
		local ok, why = run("check", targets(action, here))
		if ok and action == "rename" then
			ok, why = renamed(here)
		elseif ok and action == "create" then
			ok, why = created(here)
		elseif ok then
			ya.emit(action, named(job.args))
		end
		if not ok then
			ya.notify({
				title = "Guarded: " .. action .. " refused",
				content = why or "the guard could not run",
				timeout = 8,
				level = "warn",
			})
		end
	end,
}
