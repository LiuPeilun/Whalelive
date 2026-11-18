-- WhaleTalk 录制整理脚本(OBS Lua)
-- 录制停止后,把录像文件移动到目标根目录下按日期(YYYY-MM-DD)的子文件夹。
-- 前置:OBS 设置 → 输出 → 录制 → 录制路径 需指向目标根目录(同盘移动才可靠)。
-- 安装:OBS 菜单 工具 → 脚本 → 「+」→ 选择本文件;可在脚本面板修改目标根目录。

local obs = obslua

local target_root = "D:\\Project\\dsh-workspace\\WhaleTalk\\data\\recordings"

script_description = "录制停止后,把录像移动到目标根目录下按日期(YYYY-MM-DD)的子文件夹。"

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_path(props, "target_root", "目标根目录", obs.OBS_PATH_DIRECTORY, "", nil)
  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_string(settings, "target_root", target_root)
end

function script_update(settings)
  target_root = obs.obs_data_get_string(settings, "target_root")
end

local function handle_event(event)
  if event ~= obs.OBS_FRONTEND_EVENT_RECORDING_STOPPED then
    return
  end
  local src = obs.obs_frontend_get_last_recording()
  if src == nil or src == "" then
    return
  end
  local day = os.date("%Y-%m-%d")
  local dest_dir = target_root .. "\\" .. day
  os.execute('mkdir "' .. dest_dir .. '" 2>NUL')
  local name = string.match(src, "([^\\]+)$")
  if name == nil then
    return
  end
  local dest = dest_dir .. "\\" .. name
  local ok, err = os.rename(src, dest)
  if not ok then
    -- 同名冲突等情况:加时间戳前缀重试一次
    dest = dest_dir .. "\\" .. os.date("%H%M%S-") .. name
    ok, err = os.rename(src, dest)
  end
  print(string.format("[WhaleTalk 录制整理] %s -> %s %s", src, dest, ok and "OK" or ("失败: " .. tostring(err))))
end

function script_load(settings)
  obs.obs_frontend_add_event_callback(handle_event)
end
