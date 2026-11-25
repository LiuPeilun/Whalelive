# 项目结构与模块边界

本文是源码路径、模块职责和依赖方向的统一约定。业务流程见 [技术方案](ARCHITECTURE.md)，开发阶段见 [实施清单](ROADMAP.md)。当前仓库处于文档阶段，下列源码与运行目录随对应功能实施创建。

## 架构选择

采用模块化单体，一个仓库、一个根 `package.json`、一个本地服务进程。浏览器端提供控制台和 OBS 播放页两个入口，生产构建后由本地服务统一提供页面与接口。

服务端按业务模块组织，外部平台与服务放入独立适配器。模块通过明确导出的函数和小型接口连接，依赖在 `src/server/app.ts` 集中组装。初期使用直接函数调用完成固定事件流程。

这套结构适合单机直播，能在同一次启动中管理队列、音频播放权和紧急停止。未来更换 B 站连接方式、模型提供方或角色包时，沿用已有的内部契约。

单进程内的异步请求仍会交错执行，OBS 页面也有独立运行的播放器。单条语音、停止和租约约束需要服务端状态机、播放端配合及回归检查共同维持。

## 开发工具与页面技术

| 项目 | 默认选择 | 落地要求 |
| --- | --- | --- |
| 服务端开发运行 | `tsx watch src/server/main.ts` | P0 直接执行源码，观察源码变更并重启 |
| 页面开发 | Vite 与纯 TypeScript 模块 | 控制台与 overlay 各自组装页面功能 |
| 页面服务 | 开发时挂载 Vite 中间件 | 沿用同源页面与 API，业务 `/ws` 和 Vite 热更新使用独立升级路径 |
| 类型检查 | TypeScript `--noEmit` | 分别检查服务端和页面 |
| 回归测试 | Vitest，服务端使用 Node 环境 | 为队列、去重、取消和播放状态提供确定性检查 |
| 分发构建 | 服务端编译与 Vite 页面构建 | 在需要打包交付时补齐，并核对输出路径与启动行为 |

`tsx` 与 Vitest 的 TypeScript 转换过程配合独立类型检查使用。源码运行阶段从项目外目录启动、配置定位和数据根覆盖仍属于 P0 验收，构建产物的路径检查随分发构建一起落实。

控制台按 `features` 拆分界面逻辑，overlay 按播放器和音画轨道拆分。界面框架的后续选择依据实际表单、状态和复用复杂度评估。

开发监视重启会重建内存队列和播放会话。持续录制或直播使用普通启动模式，播放页在服务断开或租约失效时本地停止音频，恢复连接后重新登记播放端。

业务 WebSocket 固定使用 `/ws`。`vite.config.ts` 显式设置 `server.ws.path = '/__vite_hmr'`，启动时将同一 HTTP server 交给 `server.ws.server`。升级路径识别复用该配置值。业务 `ws` 采用 `noServer` 模式，升级处理器按解析后的 `pathname` 精确接管 `/ws`。Vite 保留自身对热更新路径、子协议和凭据的处理。各处理器只操作自己接管的 socket，未知升级路径明确拒绝。关闭时清理各自监听器。

Vite 当前在线文档将 WebSocket 配置归到 `server.ws`，旧版的 `server.hmr` 相应选项有兼容迁移说明。实施时先锁定版本，再使用该版本的公开配置。P0 首次联调同时检查 HMR、业务消息与服务重启后的重连。[Vite WebSocket 配置](https://vite.dev/config/server-options#server-ws)

## 目标目录

目录树中展示的是目标位置。P0 先建立实际使用的文件，P1、P2、P3 按功能补充。

```text
WhaleTalk/
├─ AGENTS.md                         AI 开发约定
├─ README.md                         项目入口与启动说明
├─ package.json                      单一依赖清单与任务入口
├─ package-lock.json                 依赖锁定，随首次安装生成
├─ tsconfig.json                     TypeScript 配置入口
├─ tsconfig.server.json              服务端与共享契约的检查范围
├─ tsconfig.web.json                 页面与共享契约的检查范围
├─ vite.config.ts                    控制台、OBS 多页面构建
├─ vitest.config.ts                  确定性回归测试，服务端使用 Node 环境
├─ .env.example                      本地环境配置模板
├─ .env.local                        本机环境配置与密钥，运行时创建
├─ .gitignore                        本地配置、数据、依赖与构建产物忽略规则
│
├─ docs/
│  ├─ ARCHITECTURE.md                原理、业务链路与技术方案
│  ├─ PROJECT_STRUCTURE.md           本文，路径与模块边界
│  ├─ ROADMAP.md                     阶段任务、验收与实施记录
│  ├─ GETTING_STARTED.md             操作者指南
│  └─ RESEARCH.md                    外部资料与核查记录
│
├─ src/
│  ├─ server/
│  │  ├─ main.ts                     读取启动参数、启动与信号退出
│  │  ├─ app.ts                      创建实例、连接模块、统一关闭资源
│  │  │
│  │  ├─ modules/
│  │  │  ├─ events/                  规范事件校验与来源去重
│  │  │  │  ├─ index.ts              模块公开入口
│  │  │  │  └─ dedup.ts              有界去重窗口
│  │  │  ├─ interaction/             互动规则、队列与任务编排
│  │  │  │  ├─ index.ts              模块公开入口与任务生命周期
│  │  │  │  ├─ queue.ts              优先级、有效期、队列容量
│  │  │  │  ├─ rules.ts              明确动作指令与回复策略
│  │  │  │  ├─ gifts.ts              礼物合并感谢与冷却
│  │  │  │  ├─ reply.ts              提示组装、短期上下文、回复校验
│  │  │  │  └─ providers.ts          模型与语音的小型业务接口
│  │  │  ├─ playback/                播放会话、轨道回执与播放端归属
│  │  │  │  ├─ index.ts              模块公开入口
│  │  │  │  ├─ session.ts            当前表演与音画轨道状态
│  │  │  │  └─ renderer-lease.ts     主播放端租约与失效处理
│  │  │  ├─ characters/              角色包、动作清单、素材解析
│  │  │  │  ├─ index.ts              模块公开入口
│  │  │  │  └─ manifest.ts           清单校验与动作查找
│  │  │  └─ settings/                配置加载、校验、保存与生效
│  │  │     ├─ index.ts              模块公开入口
│  │  │     └─ schema.ts             服务端配置结构与校验
│  │  │  ├─ singing/                 P3 点歌任务、成片缓存与换声管线编排
│  │  │  │  ├─ index.ts              模块公开入口与任务生命周期
│  │  │  │  ├─ pipeline.ts           子进程管线编排（搜歌 → 分离 → 测 f0 → 换声）
│  │  │  │  ├─ cache.ts              成片确定性缓存
│  │  │  │  └─ keys.ts               f0 自适应移调
│  │  │
│  │  ├─ integrations/
│  │  │  ├─ platforms/
│  │  │  │  ├─ mock.ts              P0 模拟事件入口
│  │  │  │  ├─ bilibili-web/        P2 普通直播连接与原始消息解析
│  │  │  │  └─ bilibili-open/       P2 官方签名、会话、心跳与解析
│  │  │  ├─ llm/
│  │  │  │  └─ deepseek.ts          P1 HTTP 请求、响应与用量映射
│  │  │  ├─ tts/
│  │  │  │  └─ edge.ts              P1 首个语音提供方
│  │  │  └─ dsh-pet/               P3 可选桌宠控制适配器
│  │  │
│  │  ├─ transport/
│  │  │  ├─ auth.ts                HTTP / WS 共用的本机凭据与作用域校验
│  │  │  ├─ http/                  路由、请求校验、响应与资源传输
│  │  │  └─ ws/                    浏览器连接、状态推送、播放回执
│  │  └─ infrastructure/
│  │     ├─ paths.ts                项目根、数据根与受控路径
│  │     ├─ logger.ts               结构化日志与脱敏
│  │     ├─ audio-cache.ts          P1 音频存储、过期与清理
│  │     └─ history.ts              P3 SQLite 历史与用量存储
│  │
│  ├─ web/
│  │  ├─ control/
│  │  │  ├─ index.html              控制台页面入口
│  │  │  ├─ main.ts                 页面初始化与功能组装
│  │  │  └─ features/               模拟器、队列、设置、状态等界面功能
│  │  ├─ overlay/
│  │  │  ├─ index.html              OBS 透明页面入口
│  │  │  ├─ main.ts                 连接、播放端注册与页面生命周期
│  │  │  ├─ player.ts               一次表演的本机执行与回执
│  │  │  ├─ video-track.ts          视频预加载、双缓冲与切换
│  │  │  └─ audio-track.ts          音频加载、播放、停止与完成
│  │  └─ shared/                   两个页面实际共用的连接与展示代码
│  │
│  └─ shared/
│     ├─ live-event.ts              标准事件类型与可复用校验
│     ├─ performance.ts             表演计划与播放回执
│     ├─ protocol.ts                HTTP / WebSocket 消息和状态视图
│     ├─ errors.ts                  跨端稳定错误码与错误响应结构
│     ├─ character.ts               页面可见的角色与动作描述
│     └─ settings.ts                页面可见的设置结构
│
├─ config/
│  ├─ defaults.json                 版本化的非敏感默认配置
│  ├─ persona.json                  默认人设
│  └─ gift-rules.json               默认礼物动作规则
│
├─ data/                            本机用户数据，整体排除版本提交
│  ├─ access.json                   首次生成的本机访问凭据，按密钥保护
│  ├─ config/                       用户设置、人设与礼物规则覆盖
│  ├─ pets/
│  │  └─ main/
│  │     ├─ manifest.json           动作清单、资源版本与授权信息
│  │     ├─ animations/             WebM 等角色动画
│  │     └─ LICENSE.txt             素材授权和署名
│  ├─ cache/audio/                  可清理的合成语音缓存
│  ├─ logs/                         运行日志
│  └─ db/                           P3 数据库
│
└─ dist/                            分发阶段的构建产物
   ├─ server/                       Node.js 服务
   ├─ shared/                       服务端使用的共享契约产物
   └─ web/                          控制台与 OBS 页面
```

## 模块职责与状态归属

| 模块 | 负责内容 | 持有状态 | 对外能力示意 |
| --- | --- | --- | --- |
| `events` | 统一事件校验、来源去重 | 有界来源键窗口 | `ingest(event)` 返回接收或重复结果 |
| `interaction` | 动作规则、礼物感谢合并、筛选、队列、生成与取消 | 唯一待播队列、当前互动任务、冷却和短期上下文 | `enqueue`、`pause`、`resume`、`stop`、队列视图 |
| `playback` | 向播放端派发表演、核对回执、完成与失败恢复 | 当前表演的音画状态、播放端租约 | `play`、`report`、`stop`、播放状态视图 |
| `characters` | 角色清单、动作白名单、资源定位和授权元数据 | 已校验角色目录与资源索引 | `list`、`resolveAction`、`resolveAsset` |
| `settings` | 默认值、用户覆盖、环境覆盖、原子保存和生效 | 已校验的有效配置与版本 | `read`、`update`、脱敏设置视图 |
| `singing` | P3 点歌任务生命周期、成片缓存、换声子进程管线编排 | 内存任务表与并发配额（成片落盘持久，重启后仍可命中缓存） | `requestSong`、`probe`、`jobsView`、`cancelAll` |

`interaction` 的当前任务可以处于等待、生成、合成或等待播放完成。`playback` 记录实际播放端的音画轨道和回执。前端队列视图来自服务端状态快照，控制操作通过命令交给持有相应状态的模块执行。

平台适配器持有连接、鉴权与心跳状态。语音缓存和数据库分别持有文件与持久记录。跨模块状态通过公开入口查询或更新，模块内部实现可独立调整。

## 依赖方向

`main.ts` 调用 `app.ts`，由 `app.ts` 创建配置、基础设施、业务模块、适配器和传输入口。业务依赖方向如下。

```text
平台适配器 → events → app 连接的回调 → interaction
                                         ├─ characters
                                         ├─ playback
                                         └─ 模型 / 语音业务接口
                                                 ↑ 实现
                                      DeepSeek / TTS 适配器

HTTP / WebSocket 处理器 → 业务模块公开入口
页面 → HTTP / WebSocket 契约 → 本地服务

src/shared ← 服务端与页面共同引用
```

- `src/shared` 保持纯类型、可序列化消息和可跨端运行的校验，依赖范围限于浏览器可用代码。
- `interaction` 通过 `providers.ts` 的小型接口使用模型和语音能力，具体实现由 `app.ts` 注入。
- `playback` 通过注入的发送函数调用已登记播放端，WebSocket 的连接对象保留在 `transport/ws`。
- `events` 返回接收结果，由 `app.ts` 连接到 `interaction.enqueue`，保持事件校验与业务选择各自完整。
- 请求对应的结果通过返回值或 Promise 回传，主动状态通知使用在 `app.ts` 装配的回调。业务模块引用沿既定依赖方向组织。
- HTTP 和 WebSocket 处理器完成输入校验、身份与角色检查、调用和映射错误，业务规则放回对应模块。
- 跨模块从模块 `index.ts` 导入。只有实际被其他模块或传输入口使用的能力才导出。
- 服务端与页面各自使用 TypeScript 检查范围，页面构建的入口限定为 `src/web` 和浏览器可用共享代码。

公共接口优先采用普通函数与 TypeScript 类型。平台接入、模型、语音、时钟和播放发送函数可以按实际替换或验证需求注入。

### 播放完成怎样返回

`interaction` 调用 `playback.play(performance, signal)`，等待 `Promise<PlaybackResult>`。播放模块根据轨道回执、取消、断线或看门狗产生一次终态结果，再由互动模块检查当前任务版本和暂停状态，决定是否处理下一条。

```ts
type PlaybackResult =
  | { performanceId: string; status: 'ended' }
  | { performanceId: string; status: 'cancelled' }
  | { performanceId: string; status: 'failed'; code: ErrorCode };
```

`ErrorCode` 定义于 `src/shared/errors.ts`。同一表演的终态结果只完成一次，重复回执和迟到回执保持幂等。取消和超时会结束本地等待，外部请求的迟到结果经过版本校验后丢弃。

播放端上线、连接丢失等主动通知可通过注入的回调发布。`playback` 调用自身依赖的发送接口并返回本次结果，`interaction` 持有任务与队列的推进逻辑。

`app.ts` 的事件接收回调负责连接已有公开能力。筛选、优先级、重试、任务状态转换和下一条调度保留在业务模块。生成管线沿现有 `reply.ts` 与 `providers.ts` 组织，流式功能出现时再按其变化范围拆分。

## 一条弹幕经过哪些位置

1. `integrations/platforms` 解析原始平台消息，生成标准事件并保留 `sourceKey`。累计礼物在此转换成本次新增数量。
2. `modules/events` 校验事件，以来源、房间和 `sourceKey` 完成去重。
3. `modules/interaction` 应用冷却与选择规则，礼物合并感谢后进入同一待播队列。
4. 任务出队时固定本轮配置版本和角色引用，执行直接动作规则或调用注入的回复与语音接口。
5. `modules/characters` 校验动作并解析可供页面访问的资源描述。
6. `modules/playback` 创建播放会话，等待指定播放端加载并派发表演。
7. `web/overlay` 执行动画、字幕和声音，通过 WebSocket 报告实际状态。
8. `modules/playback` 根据回执或看门狗完成本次 Promise，`interaction` 核对任务版本与调度状态后处理下一任务。

每一步使用 `eventId` 追踪来源，生成表演后同时记录 `performanceId`。日志可按这两个字段串联完整耗时和错误。

## 接口与页面路径

以下为目标路由，随阶段实现。源码目录与浏览器路由各自独立映射。

| 路由 | 作用 | 主要负责位置 |
| --- | --- | --- |
| `GET /control` | 操作者控制台 | `src/web/control` |
| `GET /overlay` | OBS 透明播放页 | `src/web/overlay` |
| `GET /api/health` | 服务与版本状态 | `transport/http` |
| `GET /api/state` | 脱敏连接、队列和播放快照 | 处理器组合模块公开视图 |
| `POST /api/mock/events` | 模拟事件 | mock 适配器与 events |
| `POST /api/control/action` | 人工点播动作 | interaction |
| `POST /api/control/pause` | 暂停后续调度 | interaction |
| `POST /api/control/resume` | 恢复调度 | interaction |
| `POST /api/control/stop` | 紧急停止并保持暂停 | interaction 与 playback |
| `GET /api/settings` | 脱敏设置与生效状态 | settings |
| `PUT /api/settings` | 校验并保存用户设置 | settings |
| `GET /api/singing/jobs` | 点歌面板只读快照：任务阶段、成片地址、失败原因 | singing |
| `GET /media/pets/:petId/:assetId` | 通过清单解析角色资源 | characters |
| `GET /media/audio/:audioId` | 返回有界音频缓存 | audio-cache |
| `/ws` | 状态推送、播放端登记、表演与回执 | `transport/ws` |

普通预览与 OBS 页面使用相同播放逻辑，音频播放权由播放端租约确定。控制台会话可以提交控制命令，播放端凭据用于接收播放计划、申请租约与提交回执。媒体资源采用下文定义的本机只读访问策略。

### P0 媒体访问

在当前本机可信操作者范围内，`/media/pets/:petId/:assetId` 与 `/media/audio/:audioId` 允许本机匿名只读访问。`Performance.audioUrl` 和角色资源 URL 可以直接赋给 `<audio>`、`<video>` 的 `src`。

- 媒体入口校验实际连接为回环地址，并校验配置允许的 Host。
- 支持 `GET`、`HEAD` 和合法字节范围请求，处理浏览器的预加载、重试和分段读取。
- 通过已校验角色清单或音频缓存 ID 定位文件，沿用现有路径范围校验。
- 浏览器媒体 GET 请求允许缺失 Origin，接口按上述本机只读策略检查。
- 素材加载和音频文件读取独立于播放租约，角色发声与停止仍由播放状态机决定。

本机持有资源 URL 的客户端可以读取相应素材与临时合成音频，这是该策略的访问范围。HTTP 控制、设置与业务 WebSocket 按各自的凭据策略授权。

共享协议记录媒体 URL 可直接加载及其缓存有效性，资源被清理或服务重启后由页面重新同步可用地址。若采用短时签名方案，媒体请求需在有效期内允许重复 GET、HEAD 和 Range，授权生命周期应覆盖预加载与重试。

### P0 连接注册与权限

采用本机作用域凭据。首次启动生成独立的 `control` 与 `playback` 随机凭据，保存在 `data/access.json`，普通重启沿用，显式重置时撤销旧会话。本次启动的 `runId` 仍独立更新。

启动入口提供控制台访问链接，控制台提供可复制到 OBS 的播放链接。链接以 URL fragment 携带相应用途的凭据，页面读取后用于连接认证。常规访问日志与诊断输出对完整访问链接、认证消息和授权头做脱敏。

连接流程在 `src/shared/protocol.ts` 中统一定义。

1. 升级业务 `/ws` 前校验配置允许的 Host。Origin 存在时按允许来源精确校验，Origin 缺失时按下文的本机兼容策略处理。
2. 建立连接后，在有界认证期限内提交带协议版本、所申请角色和凭据的 `auth` 消息。
3. 服务端核对凭据作用域，绑定本连接的角色，返回含 `connectionId`、实际角色和 `runId` 的认证结果。
4. 认证后的连接按权限订阅状态、登记播放端或提交播放回执，收到业务消息时继续校验所属会话。
5. 认证失败、超时或协议版本不受支持时关闭连接，控制台展示可操作提示。

| 连接角色 | P0 权限 |
| --- | --- |
| `control` | 读取控制台状态，通过 HTTP 接口发送人工控制与设置命令 |
| `playback` | 接收播放所需状态、申请播放租约、续租与回报自身播放结果 |

角色由服务端根据凭据授予，页面的角色字段用于提出申请。HTTP 控制与设置接口复用 `transport/auth.ts` 的作用域校验，页面通过授权头提交凭据。播放回执还需通过 `runId`、`leaseId`、`performanceId` 与连接归属校验。该方案以本机可信操作者为使用边界。

Origin 缺失时，只有实际 TCP 对端为回环地址且 Host 合法，才允许进入待认证状态。连接仍需在认证期限内提交有效作用域凭据，认证后才取得相应业务能力。显式提供的非法 Origin 或 `Origin: null` 按来源校验拒绝。该兼容策略用于业务 `/ws`，Vite 热更新使用其自身连接处理。

OBS 联调使用服务提供的 HTTP 播放链接，记录 OBS / CEF 版本和实际握手头类别。公开协议要求浏览器 WebSocket 携带 Origin，OBS 的具体表现以目标版本实测为准。[WebSocket 客户端握手规范](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)

播放消息和回执携带本次服务启动的 `runId`、播放端 `leaseId` 和 `performanceId`。播放页断线或本地续租看门狗到期时停止音频，收到新服务会话后清理旧播放状态。租约转交需取得旧端停止确认，或等待旧租约安全过期，再允许新端发声。

## 文件路径与配置

### 路径解析

项目根由服务入口位置解析，开发与构建后的入口均通过统一的 `paths.ts` 得到同一项目根。首次实现时验证从项目外目录启动的行为。

本机数据默认放在项目根下的 `data`，可用 `WHALETALK_DATA_DIR` 指定。该值为相对路径时相对项目根解析，绝对路径直接使用。各模块通过统一路径对象取得位置。

角色包清单中的动画路径相对本角色包根目录。资源加载时解析最终目标，并验证其处于角色包允许范围内，包含对目录穿越和符号链接目标的检查。浏览器通过 `petId`、`assetId` 和 `audioId` 读取资源。

### 配置覆盖与保存

同一设置按以下顺序得到有效值。

```text
config 中的版本化默认值
        ↓
data/config 中的用户覆盖
        ↓
.env.local 中显式配置的字段
        ↓
启动进程环境中显式配置的字段
```

API Key、Cookie 与平台密钥保存在本地环境配置或进程环境中，服务端生成供页面使用的脱敏设置视图。界面标明环境覆盖的字段与需要重启的监听端口等配置。

界面编辑的用户设置写入 `data/config`。保存过程先校验完整新配置，写入同目录临时文件，再替换目标文件并发布新的配置版本。进程内写操作串行执行，更新命令带期望配置版本，过期更新返回冲突供界面刷新。

运行中的表演保留本轮配置和角色引用，新配置在下一次调度生效。角色资源的替换和音频缓存清理需保留正在使用的引用，待播放结束后释放。

角色包、用户配置与数据库属于持久数据，缓存与日志可以按保留策略清理。升级代码时沿用已有数据目录，清单与持久设置记录格式版本以支持后续迁移。

## 出错、取消与退出

- 平台适配器处理连接和会话恢复，公开连接状态与失败原因。
- 业务调用携带取消信号、超时和本轮任务版本。迟到的模型与语音结果经版本校验后丢弃。
- 紧急停止由 `interaction.stop` 统一进入，推进取消版本、暂停调度、清空待播队列并调用 `playback.stop`。
- `playback` 核对 `performanceId`、播放端租约版本和轨道状态，重复回执保持幂等，失效回执被记录后忽略。
- `app.ts` 统一启动与关闭资源。服务退出先暂停调度，再取消任务并停止播放、结束平台会话、关闭连接和存储。
- `src/shared/errors.ts` 定义客户端可见的稳定错误码和错误响应结构，`protocol.ts` 引用该结构。服务端将外部提供方错误映射为应用错误码，客户端提供未知错误码的通用展示。
- 错误返回包含稳定错误码、阶段和可追踪 ID，控制台展示可操作说明，日志保留脱敏诊断细节。人工取消作为正常终态显示。

## 常见改动应放在哪里

| 需求 | 首选位置 | 对外契约 |
| --- | --- | --- |
| 新增直播平台 | `integrations/platforms/<provider>` | 标准 LiveEvent |
| 切换模型提供方 | `integrations/llm/<provider>.ts` | interaction 的回复接口 |
| 切换语音服务 | `integrations/tts/<provider>.ts` | interaction 的语音接口 |
| 调整礼物动作 | `data/config` 礼物规则 | 经过设置校验的规则 |
| 调整排队或冷却 | `modules/interaction` | 队列视图与控制命令 |
| 更换角色 | `data/pets/<petId>` | 版本化动作清单 |
| 改善视频切换 | `web/overlay/video-track.ts` | 播放命令与回执 |
| 改善控制台布局 | `web/control/features` | 脱敏状态与设置接口 |
| 增加历史统计 | `infrastructure/history.ts` 与调用处 | 业务定义的查询与写入接口 |

共享代码在出现稳定复用关系时提取，文件名按实际职责命名。模块内专用函数留在所属模块。回归检查随目标模块放置，例如 `queue.test.ts`、`dedup.test.ts` 与 `session.test.ts`，平台事件样本放在对应适配器附近。

## 回归检查范围

Vitest 的初始检查聚焦以下已识别风险。

- 队列容量、优先级、冷却、过期、暂停和恢复。容量测试投入超过上限的事件，核对实际丢弃行为。
- 来源去重及有界窗口过期，同一来源重复消息保持幂等。
- 累计礼物在重复和乱序样本下的增量，按连击高水位计算并保持统计值单调。
- 生成、合成或播放阶段停止后，本地等待能结束，迟到结果保持失效。
- 同一表演被重复或乱序回执更新时，终态结果只完成一次。
- 服务重启、播放端断开和租约转交后，旧会话消息保持失效。

时间相关用例使用可控时钟或 Vitest 假计时器，异步竞争使用可手动完成的 Promise 和替身提供方复现。浏览器媒体解码、音频输出和 OBS 成片分别通过页面与 OBS 实测记录。

## 按阶段落地

P0 先建立源码运行、独立类型检查和 Vitest，再建立服务入口、五个业务模块的已用部分、mock 适配器、HTTP / WebSocket、共享契约与两个纯 TypeScript 页面。人设和礼物默认配置以当期功能需要为准。

P1 在现有接口上增加 DeepSeek、首个 TTS 和音频缓存，补齐取消、预加载与音频归属。

P2 增加实际使用的 B 站接入适配器，完善原始消息样本、来源去重与连接恢复。

P3 根据完整功能需要加入 SQLite、更多提供方和可选 dsh-pet 适配器。源码目录在首次出现对应实现时创建，并同步更新本文。
