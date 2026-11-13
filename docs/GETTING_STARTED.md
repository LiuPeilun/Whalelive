# 零基础准备与操作指南

当前为方案阶段。WhaleTalk 的控制台与播放页面待开发，文中的本地地址是计划入口。现阶段可完成软件和账号准备，也可以先安装现成桌宠观察动画。

## 1. 准备清单

| 项目 | 用途 | 何时需要 |
| --- | --- | --- |
| Windows 电脑与稳定网络 | 跑本地服务、动画与 OBS | 开始前 |
| OBS Studio | 把画面与声音编码并推到直播平台 | P1 |
| Node.js 受支持的 LTS | 运行 WhaleTalk 本地服务 | P0 |
| DeepSeek API Key | 根据弹幕生成回复 | P1 |
| 语音合成方案 | 将回复变成声音 | P1 |
| 角色动作素材 | 展示人物与动作 | P0 |
| B 站直播账号与房间信息 | 真实弹幕接入和推流 | P2 |
| 开放平台凭据，选择官方接法时 | 正式事件通道 | P2 |

DeepSeek 网页聊天账号与 API 调用分别配置。API Key 在 DeepSeek 开放平台创建，使用量按平台计费。将密钥填入实现后的本地配置文件，保存于自己的电脑。[DeepSeek 平台](https://platform.deepseek.com/)

## 2. 先看现成大肥鱼

这是可立即尝试的桌宠体验路线。

1. 打开 dsh-pet 的 Releases，找到 Windows x64 绿色包 `dsh-pet-win-x64.zip`。
2. 解压，运行其中的 `dsh-pet.exe`。
3. 查看待机和右键动作，确认电脑可以正常播放动画。
4. 查看运行日志中的实际本地服务端口。

该绿色版按仓库说明包含 Electron，无需另外安装 Node.js 或 DSH。独立模式的 AI 对话依赖后续外接服务。[下载页面](https://github.com/PC2005-cloud/dsh-pet/releases) [独立模式说明](https://github.com/PC2005-cloud/dsh-pet/blob/main/INSTALL.md)

已有 Node.js 且满足 dsh-pet 当前最低版本要求 22.12.0 时，可以使用仓库提供的命令。

```powershell
npm install -g dsh-pet
dsh-pet-standalone --check
dsh-pet-standalone --port 3080
```

默认独立模式地址为 `http://127.0.0.1:3080`。访问根路径可读取服务信息。角色显示于独立桌面窗口，OBS 捕获窗口的透明效果需要实际测试。[安装说明](https://github.com/PC2005-cloud/dsh-pet/blob/main/INSTALL.md)

## 3. WhaleTalk 的计划配置

P0 开发完成后，由实现代码提供以下配置入口和可复制命令。以下是配置草案。

```dotenv
HOST=127.0.0.1
PORT=3210
PLATFORM=mock

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_THINKING=disabled

TTS_PROVIDER=edge
WHALETALK_DATA_DIR=./data
PET_ID=main

BILIBILI_ROOM_ID=
BILIBILI_COOKIE=
BILIBILI_OPEN_ACCESS_KEY_ID=
BILIBILI_OPEN_ACCESS_KEY_SECRET=
BILIBILI_OPEN_APP_ID=
BILIBILI_OPEN_ANCHOR_CODE=
```

初始 `PLATFORM=mock` 使用模拟事件。`bilibili-web` 接法按实现和当前平台要求配置房间号及登录信息，`bilibili-open` 接法配置应用凭据和主播身份码。TTS 音色列表由所选提供方加载，正式云语音服务增加其对应配置。

环境配置计划保存在项目根的 `.env.local`。`WHALETALK_DATA_DIR` 指定用户数据目录，示例中的 `main` 角色包位于 `data/pets/main/manifest.json`。界面修改的设置保存在 `data/config`，动画、日志和语音缓存分别保存在数据目录的对应子目录。备份时保留用户配置、角色包和后续数据库，本地密钥单独妥善保存。详细路径见 [项目结构](PROJECT_STRUCTURE.md)。

服务启动后，计划通过 `http://127.0.0.1:3210/control` 操作角色，通过 `http://127.0.0.1:3210/overlay` 提供 OBS 画面。端口可修改，实际地址以应用显示为准。

实际操作使用启动入口给出的控制台访问链接，并从控制台复制 OBS 播放链接。应用自动生成并保存相应用途的本机凭据，普通重启沿用，显式重置后重新复制链接。`data/access.json` 按本地密钥妥善保存。

开发时使用源码监视模式，改动服务端源码会重启服务并重置内存任务。持续录制和直播使用实现后提供的普通启动入口。页面断开后会停止当前音频，重连后重新取得播放权限。源码运行和分发构建的区别见 [开发工具约定](PROJECT_STRUCTURE.md)。

## 4. 把透明画面加入 OBS

以下步骤用于 WhaleTalk 的浏览器画面路线，需先完成 P0 / P1。

1. 安装并打开 OBS，新建一个场景。
2. 在“来源”中添加背景图片、颜色或自己的直播场景。
3. 添加“浏览器”来源，名称可以填写“WhaleTalk 角色”。
4. URL 填入应用给出的 `/overlay` 地址，使用 URL 加载。
5. 首次可设置为 1280 × 720、30 FPS，并让 OBS 画布与输出分辨率一致。
6. 将角色来源放到背景上方，检查透明区域、人物尺寸、字幕与屏幕边缘。
7. 首次联调时关闭“不可见时关闭源”和“场景变为活动状态时刷新浏览器”。切场景后观察页面连接和播放状态。

OBS 浏览器源支持网页画面、透明背景与音频。WebM 透明通道的最终效果还需在当前 OBS 版本实测，素材有黑底时先确认源文件带 alpha，再检查播放器和浏览器源。[OBS 浏览器源说明](https://obsproject.com/kb/browser-source)

## 5. 让声音只出现一次

1. 在浏览器来源属性中启用“通过 OBS 控制音频”，具体名称随版本语言可能略有差异。
2. 从 WhaleTalk 发起语音试听，在 OBS 混音器确认角色来源的音量条变化。
3. 普通浏览器预览保持静音，指定 OBS 页面为音频播放端。
4. 首次把角色音频监听设为“关闭监听”，录制 30 秒并回放，确认输出含声音。
5. 需要自己监听时选择对应监听设备，再检查桌面音频是否同时采集该设备，调整到单一路径。

若音量条有变化而录制无声音，检查音轨分配、静音、来源属性与输出设置。若声音重叠，检查预览页面、重复浏览器源和桌面音频采集路径。

## 6. 接入 B 站弹幕

### 普通接法

在控制台选择普通 B 站连接，填房间号。若界面提示登录信息缺失或过期，按适配器的登录说明处理，并在本机保存。用第二设备发一条“你好”，先检查事件面板，再检查回复和动作。bilive-danmaku 的 README 提醒，未登录可能无法取得完整弹幕数据。[弹幕项目说明](https://github.com/Beats0/bilive-danmaku)

### 官方接法

按开放平台当前接入说明申请开发者与项目，获得应用凭据，再由主播提供身份码。控制台应显示互动会话、长链和心跳状态。只填房间号无法完成官方应用鉴权。[开放平台](https://open-live.bilibili.com/) [官方接入示例](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo)

两种方式各自核对实际连接要求，相关凭据放在本地服务配置中。

## 7. 从测试到开播

1. 先用模拟事件验证吃饭、跳舞、感谢、说话和紧急停止。
2. 配好 DeepSeek 和 TTS，完成一次完整回复，再断开外部服务验证错误提示。
3. OBS 本地录制 30 分钟，回放检查画面、字幕、声音和切换。
4. 接入目标房间，用另一设备发真实弹幕，核对回复对象。
5. 确认当前账号的直播权限、角色与声音授权，以及平台页面显示的 AI / 虚拟形象要求。
6. 从 B 站直播中心取得推流配置，填入 OBS，先采用平台建议的编码参数。
7. 开播后从观众设备检查成片，分别记录发弹幕、角色回应与观众看到回应的时间。
8. 收播时停止推流，再停止平台互动会话和本地程序。

推流密钥同样属于本地敏感配置。开播与收礼用途采用覆盖相应用途的角色授权。[素材许可](https://github.com/PC2005-cloud/dsh-pet#许可)

## 8. 常见问题

| 现象 | 排查顺序 |
| --- | --- |
| OBS 页面打不开 | 本地程序是否启动、端口是否一致、地址是否可在浏览器访问 |
| 人物黑底 | 素材是否带 alpha、是否为透明 WebM、OBS 浏览器源解码结果 |
| 切动作闪黑 | 新动作是否预加载、首帧是否可用、双缓冲切换是否成功 |
| 角色有文字却没声音 | TTS 状态、音频加载结果、播放端归属、OBS 静音与音轨 |
| 同一句读两次 | 重复 OBS 来源、浏览器预览、桌面音频、来源事件去重 |
| 弹幕收不到 | 房间号、登录态或应用授权、长链鉴权、心跳和错误面板 |
| 回复越来越迟 | 队列等待、语音长度、调用耗时、用户冷却和过期任务清理 |
| 停止后又开口 | 在途请求的取消标识、迟到结果丢弃、旧页面播放归属 |
| 礼物数量偏大 | 增量与累计字段、连击统计通知是否双算、来源去重键 |
