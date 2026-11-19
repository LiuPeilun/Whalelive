-- WhaleTalk 录制整理脚本(OBS Lua)
-- 录制停止后,把录像文件移动到目标根目录下按日期(YYYY-MM-DD)的子文件夹。
-- 前置:OBS 设置 → 输出 → 录制 → 录制路径 需指向目标根目录(同盘移动才可靠)。
-- 安装:OBS 菜单 工具 → 脚本 → 「+」→ 选择本文件;可在脚本面板修改目标根目录。
--
-- 实测修正(2026-11-19):停止录制后 Windows 上 MP4 句柄未立即释放,
-- 立即 os.rename 会静默失败(目标文件夹建好但文件留在根目录)。
-- 改为定时重试:每 500ms 尝试一次,最多 60 次(30 秒),成功后自动撤销定时器。

local obs = obslua

local target_root = "D:\\Project\\dsh-workspace\\WhaleTalk\\data\\recordings"

local rename_timer_active = false

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
  local name = string.match(src, "[^/\\]+$")  -- 兼容 / 与 \ 两种分隔符(OBS 返回正斜杠)
  if name == nil then
    return
  end
  local dest = dest_dir .. "\\" .. name

  -- 立即试一次(多数情况句柄已释放);失败进入定时重试
  local ok = os.rename(src, dest)
  if ok then
    print(string.format("[WhaleTalk 录制整理] %s -> %s OK", src, dest))
    return
  end

  -- 句柄未释放:启动重试定时器(500ms×60 次=30s 上限)
  if rename_timer_active then
    return -- 上一次仍在重试中:不叠加定时器
  end
  rename_timer_active = true
  local attempts = 0
  local function retry()
    attempts = attempts + 1
    local done = os.rename(src, dest)
    if done then
      obs.timer_remove(retry)
      rename_timer_active = false
      print(string.format("[WhaleTalk 录制整理] %s -> %s OK(第 %d 次重试)", src, dest, attempts))
    elseif attempts >= 60 then
      obs.timer_remove(retry)
      rename_timer_active = false
      print(string.format("[WhaleTalk 录制整理] 失败: 30 秒内无法移动 %s(文件可能仍被占用),请手动移动到 %s", src, dest_dir))
    end
  end
  obs.timer_add(retry, 500)
  print(string.format("[WhaleTalk 录制整理] 句柄未释放,500ms 后开始重试移动 -> %s", dest))
end

function script_load(settings)
  obs.obs_frontend_add_event_callback(handle_event)
end
