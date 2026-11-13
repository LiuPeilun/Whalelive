# 来源与事实核查

核查日期为 2026 年 11 月 13 日，按 Asia/Shanghai 日期记录。本次通过公开 README、源码和官方网页核查，尚未进行账号登录、API 付费调用、软件安装或真实直播联调。

## 1. bilive-danmaku

项目为 Electron / React 直播弹幕客户端，代码许可为 MIT。README 列出 `DANMU_MSG`、`SEND_GIFT`、`COMBO_SEND`、`GUARD_BUY` 和 `SUPER_CHAT_MESSAGE` 等消息，并提示未登录可能无法取得弹幕数据。翻译功能被标记为失效，语音朗读说明使用 edge-tts。[仓库](https://github.com/Beats0/bilive-danmaku)

核查时 `master` 提交为 `5861f8e70035df1030e82d90c53c6475779d3b15`。连接实现包含获取弹幕服务器、鉴权、30 秒 WebSocket 心跳、Brotli 解压与消息分发。接口实现包含 WBI 签名、`buvid` 与登录 Cookie 读取。适合作为事件接入参考，目标账号、当前接口和消息格式需要实测。[连接源码](https://github.com/Beats0/bilive-danmaku/blob/5861f8e70035df1030e82d90c53c6475779d3b15/src/renderer/components/Danmaku/base/Socket.ts) [接口源码](https://github.com/Beats0/bilive-danmaku/blob/5861f8e70035df1030e82d90c53c6475779d3b15/src/renderer/api/index.ts)

## 2. dsh-pet

核查时 `main` 提交为 `e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf`，包清单版本为 0.4.8，Node.js 最低要求为 22.12.0。项目有 100 多段透明动画、桌面模式与浏览器 overlay，并提供独立 Windows 绿色包。默认播放资源为 640 × 360 VP9-alpha WebM。[固定提交](https://github.com/PC2005-cloud/dsh-pet/tree/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf) [包配置](https://github.com/PC2005-cloud/dsh-pet/blob/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf/dsh-pet/package.json)

HTTP 能力包括状态、第三方锁、动画点播、播放回执、外部文本气泡、对话与语音。独立模式默认监听 3080，端口占用时顺延。独立模式 `/chat`、`/whisper` 通过结构化失败说明缺少模型提供方，`/balance` 返回不支持。[HTTP 说明](https://github.com/PC2005-cloud/dsh-pet/blob/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf/API.md) [安装说明](https://github.com/PC2005-cloud/dsh-pet/blob/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf/INSTALL.md)

语音源码包含输入校验、队列、缓存、超时和 Edge 语音合成，HTTP `voice/speak` 成功时返回 `audio/mpeg`。作为候选语音适配器时，需要验证网络连通性、音色和取消流程。[语音服务](https://github.com/PC2005-cloud/dsh-pet/blob/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf/dsh-pet/src/host/voice/speak.ts) [语音路由](https://github.com/PC2005-cloud/dsh-pet/blob/e755e7be5b67ff1ebde5f4eed39ab9e58a2f16bf/dsh-pet/src/host/routes/voice.ts)

### 许可的两部分

- 代码采用 MIT。
- 仓库说明形象为社区二创，原型“溟月”与 DeepSeek 版设计分别有列明的作者，角色形象采用 CC BY-NC-SA 4.0，并引用禁止商业化的声明。
- 仓库要求衍生 / 改版 / 换皮作品在公开渠道附上原作者 GitHub 地址。

当前来源不能支持“代码开源即可用同一角色收礼变现”的结论。项目可开发平台礼物事件交互，面向实际商业用途的角色应有覆盖该用途的许可。此次核查读取了仓库对许可声明的引用，角色作者的当前授权情况仍需向授权方确认。[仓库许可章节](https://github.com/PC2005-cloud/dsh-pet#许可) [仓库引用的声明](https://www.bilibili.com/opus/1247156596114456581) [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)

## 3. B 站直播开放平台

官方 C# 示例明确配置 `AccessKeyId`、`AccessKeySecret`、`AppId` 和主播身份码 `Code`。程序启动互动玩法后取得场次与 WebSocket 信息，维持应用心跳，订阅弹幕、礼物、大航海、醒目留言等事件，并在结束时调用结束接口。[官方示例 README](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo) [示例程序](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo/blob/master/OpenBLiveSample/Program.cs)

示例的数据结构包括 `game_info.game_id`、`websocket_info.wss_link` 和 `websocket_info.auth_body`。当前接入所需权限、申请周期、配额、事件字段、心跳要求与适用范围，应以开放平台当前文档和账号后台为准。[返回结构](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo/blob/master/OpenBLive/Client/Data/AppStartInfo.cs) [官方接入文档](https://open-live.bilibili.com/document/eba8e2e1-847d-e908-2e5c-7a1ec7d9266f) [长链命令文档](https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8)

公开资料支持实时事件接入方案。整条链路仍需测量平台消息推送、网络、排队、文本生成、语音合成和推流播放的耗时，“无延迟”应转换成明确的测量点和工程目标。

## 4. DeepSeek

核查时官方首次调用文档使用 `deepseek-flash`，模型页面标注其对应 DeepSeek-V4.1-Flash-1017。OpenAI 格式服务地址为 `https://api.deepseek.com`，示例调用 `/chat/completions`。模型配置在应用中保持可修改。[首次调用](https://api-docs.deepseek.com/) [模型与价格](https://api-docs.deepseek.com/quick_start/pricing)

官方思考模式文档说明默认开启思考，关闭方式为 `thinking: { type: 'disabled' }`。直播的短对话建议以关闭思考作为初始配置，并实测回复时长。[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)

JSON 模式使用 `response_format: { type: 'json_object' }`，提示中包含 `json` 及格式示例。官方文档提醒可能出现空白输出或长度截断，应用应处理这些情况并校验业务字段。[JSON 输出](https://api-docs.deepseek.com/guides/json_mode)

核查日价格页列出的 Flash 每百万 tokens 美元价格如下。

| 类型 | 非高峰 | 高峰 |
| --- | --- | --- |
| 缓存命中输入 | 0.003 | 0.006 |
| 缓存未命中输入 | 0.15 | 0.30 |
| 输出 | 0.60 | 1.20 |

费用示例按该页面计算，实际账单以调用时价格和用量为准。预算记录保留输入、输出、缓存和调用时间段。[官方价格](https://api-docs.deepseek.com/quick_start/pricing)

## 5. OBS 与语音

OBS 浏览器源可加载 URL 或本地网页，支持网页视觉与音频。官方说明列出尺寸、帧率、透明背景 CSS、隐藏时关闭与场景激活时刷新等设置。[OBS 浏览器源](https://obsproject.com/kb/browser-source)

edge-tts 为 Microsoft Edge 在线语音服务的开源调用工具，可作为原型语音合成候选。稳定性、访问条件、声音使用条款和具体商业用途按所选服务核对。[edge-tts](https://github.com/rany2/edge-tts)

## 6. 待实测清单

| 项目 | 所需条件 | 验证结果记录位置 |
| --- | --- | --- |
| 目标房间弹幕和礼物字段 | 房间信息及连接凭据 | ROADMAP P2 |
| 账号的开放平台权限 | 应用与主播配置 | ROADMAP P2 |
| DeepSeek 模型与实际耗时 | API Key | ROADMAP P1 |
| TTS 音色、耗时与连通性 | 所选语音服务 | ROADMAP P1 |
| OBS 透明 WebM 与声音 | 本机 OBS 和实现后的播放页面 | ROADMAP P1 |
| dsh-pet 桌面窗口透明捕获 | 现成桌宠和 OBS | 使用复用路线时记录 |
| 角色的收礼变现授权 | 适用许可或授权方确认 | 角色包来源记录 |

本文记录资料事实与设计依据，功能实现及实际运行结果以实施记录为准。

## 7. Vite 中间件与业务 WebSocket 共存

2026 年 11 月 13 日补核当前 Vite 在线文档。文档提供 `server.ws.server` 与 `server.ws.path` 以指定共用 HTTP server 和热更新连接路径，并说明旧版 `server.hmr` 对应选项的兼容迁移。实际配置以 P0 安装并锁定的版本为准。[官方服务配置](https://vite.dev/config/server-options#server-ws)

核查时主分支源码使用 `noServer` WebSocket，并在共用 HTTP server 的升级处理器中按热更新子协议与 URL 路径匹配。实现应保留 Vite 自身处理，业务处理器精确接管 `/ws`，同时验证两种连接与资源关闭行为。主分支源码用于说明机制，项目实际接入需依据锁定版本测试。[Vite WebSocket 源码](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/ws.ts)

`/__vite_hmr` 是项目选定路径，实施时在锁定版本对应的 Vite WebSocket 配置中显式设置，并与升级路径识别共用配置值。

## 8. WebSocket Origin 与 OBS 待测行为

2026 年 11 月 13 日补核 RFC 6455。第 4.1 节要求浏览器客户端的 WebSocket 握手携带 Origin，非浏览器客户端可以按用途选择。来源校验与凭据认证分别承担来源限制和业务授权。[客户端握手规范](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)

本轮公开资料核查尚未取得足以确认“部分 OBS 版本不发送 Origin”的具体版本与复现记录。目标 OBS / CEF 的行为列入 P0 实测，缺失 Origin、显式非法 Origin 与 `Origin: null` 分别验证。项目为缺失 Origin 的合法回环连接定义有条件的凭据认证流程。
