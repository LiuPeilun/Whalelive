# OBS 录制整理脚本

`organize-recordings.lua` — 录制停止后，把录像移动到 `目标根目录\YYYY-MM-DD\` 日期子文件夹。

## 安装(一次性)

1. **改录制路径**(OBS 菜单 设置 → 输出 → 录制 → 录制路径):
   ```
   D:\Project\dsh-workspace\WhaleTalk\data\recordings
   ```
   目录不存在就先手动创建一次(或先录一段，OBS 会提示创建)。
   路径必须与本脚本目标根目录同盘(D 盘)，跨盘移动不可靠。
2. **加载脚本**(OBS 菜单 工具 → 脚本 → 左下 `+` → 选择本目录的 `organize-recordings.lua`);
3. 脚本面板中可修改「目标根目录」，默认即上面的路径。

## 生效方式

每次点「停止录制」后，脚本把刚生成的录像文件移动进
`data\recordings\2025-xx-xx\`(当天日期)。

- 结果会打印在 OBS 脚本面板的日志区(`[WhaleTalk 录制整理] ... OK`);
- 若显示失败，把日志行发给开发，不要手动挪动源文件。

`data/` 已被项目忽略规则覆盖，录像不会进 git。
