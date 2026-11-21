# 大肥鱼互动直播技术方案

核查日期为 2026 年 11 月 13 日。本文描述推荐架构与待开发契约，实际实现进度见 [实施清单](ROADMAP.md)。

## 1. Q 版人物怎样动起来

常见方案使用提前生成或制作好的角色动作片段。程序收到事件后，选择对应动画并切换播放，例如待机、挥手、吃饭、跳舞、拆礼物与思考。

当前角色素材「大肥鱼 · 潮汐邮差」为本项目自制（ImageGen 辅助立绘 + 本地渲染导出），播放素材为 640 × 360 的 VP9-alpha WebM。透明通道让人物可以叠加到直播背景上。素材包自带构建脚本（`build.mjs`）可复用制作流程扩充动作。放大到直播画面时，实际清晰度受源素材分辨率影响。

DeepSeek 根据弹幕生成人设化回复，也可以建议一个动作 ID。后台检查动作是否存在，再交给播放页面执行。待机动作、明确的“跳舞”指令和礼物触发可以直接通过规则选择，减少等待和调用成本。

说话阶段可循环已有说话动画，并同步字幕和音频。若需要嘴型逐字匹配，后续增加音素时间轴、口型图层或可驱动的 Live2D / 3D 模型。预制 WebM 的身体与嘴部已经合成，音量只能辅助驱动缩放、发光或额外口型图层。

## 2. 两条可行路线

| 路线 | 做法 | 适合阶段 | 需验证的部分 |
| --- | --- | --- | --- |
| 复用现成桌宠 | 安装 dsh-pet，通过 HTTP 控制动作和气泡，OBS 捕获角色窗口 | 已在使用 DSH 或桌宠，快速观察互动效果 | 窗口透明捕获、音频归属、占用锁与播放回执 |
| 独立直播工具，推荐 | WhaleTalk 服务管理互动，独立浏览器页面播放动画，OBS 添加浏览器源 | 建立稳定、可维护、可换角色的直播工具 | 首次开发需要完成动画播放器、控制台和语音编排 |

推荐路线直接读取经过授权的动画文件，形成适配 OBS 的透明页面。单一角色与直播控制服务可以独立运行。dsh-pet 的动作设计、素材制作流程与 API 都可以作为复用基础。

### 复用 dsh-pet 的已确认接口

默认独立模式服务地址为 `http://127.0.0.1:3080`，端口占用时可能顺延，实际值以启动输出为准。DSH 模式使用 DSH 自己的 Web 端口。接口前缀 `/dsh-pet-7340` 中的 `7340` 是路由名称。[安装说明](https://github.com/PC2005-cloud/dsh-pet/blob/main/INSTALL.md)

- `GET /dsh-pet-7340/state` 读取状态，支持长轮询。
- `POST /dsh-pet-7340/lock?pet=main` 获取第三方占用锁。
- `POST /dsh-pet-7340/anim?pet=main&lock=<lockId>` 播放指定动作，并取得 `playbackId`。
- `GET /dsh-pet-7340/playback/{id}` 读取实际播放状态。
- `POST /dsh-pet-7340/broadcast?pet=main&lock=<lockId>` 展示外部生成的文本，可配置是否朗读。
- `POST /dsh-pet-7340/lock/release?pet=main` 释放占用锁。
- `POST /dsh-pet-7340/voice/speak` 合成并返回 MP3，可作为语音适配器候选。

具体请求体、租约与播放状态以固定版本的 OpenAPI 契约为准。外部控制需续租，并在结束或取消时释放锁。人工拖拽或隐藏宠物会使锁失效，需要处理 `lock-lost`。动作接口返回成功后还需等待播放回执。独立模式 `/chat`、`/whisper` 返回 `provider-missing`，AI 对话可由 WhaleTalk 自行调用 DeepSeek。[HTTP 契约](https://github.com/PC2005-cloud/dsh-pet/blob/main/API.md)

## 3. 推荐架构

```text
模拟器 / B 站普通 WebSocket / B 站开放平台
                    ↓
             统一事件与去重
                    ↓
             筛选、冷却、队列
                    ↓
                互动编排器
             ↙              ↘
        动作与礼物规则      DeepSeek 回复
             ↘              ↙
              表演计划与校验
                    ↓
                语音合成
                    ↓
      本地 WebSocket → OBS 播放页面
                    ↓
        动画 / 字幕 / 音频 / 播放回执
                    ↓
                OBS → B 站

控制台 → 手动动作 / 暂停 / 清队列 / 紧急停止
```

默认部署为 Windows 单机，采用模块化单体，一个根依赖清单、一个 Node.js 服务、控制台与 OBS 播放页两个浏览器入口。TypeScript 负责本地服务与前端，Vite 用于页面开发，Fastify 用于 HTTP 接口，`ws` 用于状态与播放消息。依赖以实施时稳定版本为准，安装后锁定。P0 与 P1 的队列可保存在内存，历史与用量记录在后续引入 SQLite。

P0 服务端通过 `tsx watch` 执行源码，Vite 开发中间件提供两个纯 TypeScript 页面。类型检查单独运行，核心状态与边界使用 Vitest 验证。分发时再补齐构建产物与对应路径检查。

服务端按 `events`、`interaction`、`playback`、`characters`、`settings` 五个业务模块组织。`interaction` 统一持有互动队列和生成任务，`playback` 持有实际音画轨道与播放端租约。B 站、DeepSeek 和 TTS 的具体接入放在 `src/server/integrations`，由 `app.ts` 组装。路径与依赖的完整约定见 [项目结构与模块边界](PROJECT_STRUCTURE.md)。

```text
src/server/modules/         事件、互动、播放、角色、设置
src/server/integrations/    平台、模型、语音和可选桌宠适配器
src/server/transport/       HTTP 与 WebSocket 入口
src/server/infrastructure/  路径、日志、缓存与存储
src/web/control/            操作者控制台
src/web/overlay/            OBS 透明播放页
src/web/shared/             页面间实际复用的代码
src/shared/                 浏览器可用的跨端契约
config/                     版本化默认值、人设与礼物规则
data/config/                用户设置覆盖
data/pets/                  本机角色包与授权记录
data/cache/                 可清理缓存
data/logs/                  运行日志
data/db/                    后续持久存储
```

## 4. B 站弹幕怎样接入

### 普通直播 WebSocket

用户给出的 bilive-danmaku 是 Electron / React 弹幕客户端。可以参考其登录态、弹幕服务器发现、鉴权包、心跳、消息解压和事件解析逻辑。项目当前包含 `getDanmuInfo`、WBI 签名、`buvid`、可选登录 Cookie 与 Brotli 消息处理。[连接实现](https://github.com/Beats0/bilive-danmaku/blob/master/src/renderer/components/Danmaku/base/Socket.ts)

将需要的逻辑封装为平台适配器，连接后把原始命令转换为内部事件。普通接口的登录要求与字段可能变化，房间号可先解析为真实长房间号。鉴权失败需展示错误，使用退避重连并在需要时重新获取连接凭据。[接口实现](https://github.com/Beats0/bilive-danmaku/blob/master/src/renderer/api/index.ts)

### 直播开放平台

按开放平台流程申请开发者及应用权限，配置 `accessKeyId`、`accessKeySecret`、`appId` 和主播身份码。调用签名后的开启接口，取得 `game_id`、`wss_link` 与 `auth_body`，连接长链并维持应用心跳和 WebSocket 心跳，退出时结束本场互动会话。签名计算放在服务端。[官方示例](https://github.com/bilibili-openplatform/OpenLive_CSharpDemo)

官方样例中的历史心跳说明为每 20–60 秒一次，实际周期应按照当前文档与接入规则确定。长链重连和会话过期分别恢复，防止使用失效鉴权无限重试。开放平台事件的用户标识可能是 `open_id`，内部将其保留为带来源的字符串，接入前核对当前字段。[长链命令文档](https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8)

两种接法都可以实时推送事件。开放平台提供正式授权与约定的数据通道，端到端延迟还包括网络、排队、生成、合成和推流播放。以下数值属于工程目标，需以实测修订。

| 观察点 | 初始目标 | 测量方式 |
| --- | --- | --- |
| 本地收到事件到动作开始 | 预加载后 P95 小于 500 毫秒 | 服务端接收时间与播放端开始回执 |
| 已选中问题到首段语音开始 | 良好网络下争取 2–5 秒 | LLM 开始到音频开始，单列排队时间 |
| 观众发弹幕到看到回应 | 由平台链路与本地处理共同决定 | 第二设备发消息并观察直播成片 |

## 5. 统一事件与礼物处理

```ts
type LiveEvent = {
  id: string;
  sourceKey: string;
  source: 'mock' | 'bilibili-web' | 'bilibili-open';
  roomId: string;
  type: 'chat' | 'gift' | 'guard' | 'superchat' | 'enter' | 'like';
  user: { id: string; name: string };
  text?: string;
  gift?: {
    id: string;
    name: string;
    quantity: number;
    comboId?: string;
    coinType?: string;
    unitPrice?: number;
    priceUnit?: string;
  };
  receivedAt: number;
};
```

这是内部契约草案。`quantity` 表示本次新增数量，金额字段保留平台单位，展示人民币时使用经过核对的单位换算。付费、免费礼物和大航海分别根据来源字段处理。

每个适配器将平台原始消息 ID 映射到 `sourceKey`，由 `events` 模块按来源、房间与该来源键统一去重。若来源缺少稳定 ID，可用明确时间窗口内的字段指纹降级，并记录此模式可能合并相同消息。内部随机生成的 `id` 用于追踪。

礼物连击先判断数据语义。单次增量直接累计，累计快照按同一连击的已见高水位计算新增数量，重复或乱序快照保持高水位单调。同一连击的统计通知只更新汇总。普通接口中的 `SEND_GIFT` 与 `COMBO_SEND` 可能描述同一连击，接入时依据事件样本确定计数来源，避免双算。默认在 2 秒窗口合并感谢，同一动作设置冷却。

模拟规则举例。

| 事件 | 动作 | 回复方式 |
| --- | --- | --- |
| “大肥鱼跳个舞” | `dance` | 简短确认，可直接执行 |
| “今天吃什么” | `eat` 或 `think` | DeepSeek 生成一句回复 |
| 礼物事件 | `gift` | 模板感谢，合并同一用户连击 |
| 大航海 / 醒目留言 | `celebrate` | 优先进入待播队列 |
| 空闲 | `idle` 及少量随机动作 | 可配置低频自言自语 |

礼物规则在模拟环境中验证。上线使用的角色、语音和素材应具备对应直播用途的授权。当前角色素材为本项目自制，版权归属项目操作者。

## 6. DeepSeek 与角色人设

截至核查日，DeepSeek 官方文档推荐 `deepseek-flash` 作为 Flash 模型调用名，服务地址为 `https://api.deepseek.com`。低延迟聊天默认关闭思考模式，发送 `thinking: { type: 'disabled' }`。模型名与该参数保持可配置，并在首次接入时做一次真实请求验证。[首次调用](https://api-docs.deepseek.com/) [思考模式](https://api-docs.deepseek.com/guides/thinking_mode)

回复建议使用 JSON 模式，系统提示包含 `json` 与完整格式示例。模型可能返回空内容、被截断内容或业务字段错误，服务端做解析与白名单校验，失败后使用简短保底回复。[JSON 模式](https://api-docs.deepseek.com/guides/json_mode)

```json
{
  "say": "今天吃火锅呀，给你留个位置。",
  "emotion": "happy",
  "action": "eat"
}
```

初始人设应写明昵称、语气、背景与回复长度。建议每次 1–2 句、约 20–60 个汉字，具体按音频时长调整。系统提示规定观众文本属于待回复内容，动作字段从允许的 ID 中选择。

MVP 保留最近 6 轮已完成互动作为短期上下文，并把发言者标识写入每轮观众消息。更长期记忆按稳定用户标识分别存储，记录删除与保留时长。通过队列控制对话顺序，避免多个观众的并行结果错配。

P1 先取得完整短回复，再合成一段语音，便于验证结构化动作。P3 可引入专门的分句协议，先校验完整句子再送入 TTS，句子顺序使用序号和取消标识维护。流式 JSON 的半成品需等待字段完整后再处理。

## 7. 语音与动画同步

DeepSeek 的文本对话调用输出文字。声音由独立的文本转语音服务产生。原型可选 edge-tts 或 dsh-pet 的语音接口，持续运行可接云语音服务。edge-tts 使用 Microsoft Edge 的在线语音服务，原型接入通常无需单独申请该服务的 API Key，实际连通性仍需测试。[edge-tts](https://github.com/rany2/edge-tts)

播放流程如下。

1. 生成文本并选择允许的动作。
2. 生成音频，在受控缓存目录中保存。
3. 播放页面预加载音频和动作，回报 `ready`。
4. 调度器下发同一 `performanceId`，开始字幕、动作与音频。
5. 动画较短时按配置循环说话动作，音频结束后回待机。
6. 失败或取消时停止对应轨道，释放播放归属并处理下一条。

TTS 失败时可以保留字幕和动作，控制台显示语音错误。动画素材失败时保留最近可用画面或待机替代，并回报失败。回复生成超时则使用保底文本。

## 8. 播放协议与调度

计划中的服务页面为 `/control` 与 `/overlay`，默认服务端口拟定为 `3210`，最终以实现配置为准。模型与平台密钥保存在服务端，本机页面使用服务端按用途发放的访问凭据。连接注册、作用域和 HTTP / WS 校验见 [项目结构](PROJECT_STRUCTURE.md)。

P0 媒体 URL 采用本机匿名只读访问，校验合法 Host、回环连接和资源映射，并支持媒体元素的 HEAD / Range 请求。音频与角色文件可直接通过 `src` 加载，控制接口和播放会话继续执行凭据校验。访问范围包含本机持有 URL 的客户端对临时合成音频的读取。

```ts
type Performance = {
  id: string;
  sourceEventId: string;
  priority: number;
  say: string;
  action: string;
  audioUrl?: string;
  expiresAt: number;
};

type PlaybackReport = {
  runId: string;
  leaseId: string;
  performanceId: string;
  rendererId: string;
  track: 'animation' | 'audio';
  status: 'ready' | 'started' | 'ended' | 'cancelled' | 'failed';
  at: number;
  reason?: string;
};
```

优先级默认采用人工停止、人工点播、礼物与付费留言、被选中问题、普通聊天、空闲动作。人工停止立即生效，其余事件默认等待当前语音结束，队列选择下一条时按优先级并考虑等待时长。可在后续加入有界的高优先级插播。

初始参数均可调整。

| 项目 | 初始值 |
| --- | --- |
| 待处理互动上限 | 20 条，满时先移出过期普通聊天，记录原因 |
| 普通聊天有效期 | 30 秒 |
| 同用户回复冷却 | 10 秒 |
| LLM 总超时 | 8 秒 |
| TTS 总超时 | 10 秒 |
| 模型最大输出 | 256 tokens，结合实际 JSON 长度调整 |
| 单次语音目标时长 | 约 3–8 秒 |
| 最近已完成对话 | 6 轮 |

同一时间只有一个拥有音频播放权的页面。普通浏览器预览默认静音，OBS 页面申请播放归属。播放命令与回执关联本次服务启动的 `runId`、播放端 `leaseId` 和 `performanceId`，播放页断线或本地续租看门狗到期时停止音频。转交前取得旧端停止确认，或等待旧租约安全过期。页面刷新时同步当前状态与表演有效期，处理断线期间遗留任务。

紧急停止从 `interaction.stop` 统一进入，中止在途请求或使其结果失效、清空队列、调用 `playback.stop` 停止当前音频并回到待机，同时保持调度暂停。操作者显式恢复后再调度后续任务。调度器用取消代数或版本令牌丢弃迟到的 DeepSeek / TTS 结果，防止停止后重新开口。

播放模块通过 `playback.play` 返回的 Promise 完成本次终态结果，互动模块据此继续调度。回执重复、取消与超时竞争时，同一结果只完成一次。单进程内仍需保持调度状态转换一致，服务端取消与浏览器停止分别验证。

播放端使用预加载与双视频缓冲，待新片段具备可播放帧后切换。处理 `loadeddata`、`playing`、`ended` 和 `error`，在支持时通过视频帧回调确认首帧。用回执和看门狗共同避免黑屏及永久占用。

## 9. 性能与费用

云端生成文本与语音、本地播放预制动画时，电脑主要承担 OBS 编码、浏览器解码与网络连接。可以先用已有 Windows 电脑做 720p / 30 FPS 录制验证，16 GB 内存与硬件编码可作为舒适起点，独显需求根据分辨率、场景与实际负载确定。

输出能力受语音时长限制。若平均一句 6 秒，每分钟大约能连续播 10 条，实际还需留出停顿与动作时间。高峰期要通过问题筛选、重复问题合并、冷却与过期丢弃保持互动及时。

模型费用按实际输入、输出与缓存命中分别计算。举例每分钟调用 6 次、持续 2 小时，共 720 次。若每次输入 800 tokens、输出 100 tokens，总量约为 57.6 万输入与 7.2 万输出。按核查日 Flash 未命中缓存峰时价格每百万输入 0.30 美元、输出 1.20 美元估算，模型费用约 0.26 美元。实际费用随历史长度、缓存、时间段和价格变化，TTS、网络和其他服务另计。[官方价格](https://api-docs.deepseek.com/quick_start/pricing)

## 10. 素材与上线条件

角色包应记录来源、版本与适用用途，保持许可状态与实际素材一致。当前角色素材「大肥鱼 · 潮汐邮差」为本项目自制（2026-11-21 启用），版权归项目操作者，可覆盖收礼变现直播用途；后续更换素材时同步更新本节与角色清单的许可描述。

真实开播前按平台当前页面核对直播权限、分区与 AI / 虚拟形象相关要求。把当前账号和用途对应的结果记录在开播记录中。保留人工静音、暂停 AI 和停止推流入口。
