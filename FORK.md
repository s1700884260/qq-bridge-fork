# 这个 fork 加了什么

上游是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）。这份 fork 不改上游的协议层，只补
「让它在真实群里长期跑得住」的那一层。下面是全部差异，按价值排序。

## 1. 省钱：本地小模型分流（`socialV2.localTriage`）

上游只有在命中 @/关键词/拍一拍时才醒；「按概率随机插话」的路径是盲醒，群聊一热闹就烧 token。

这里增加了一层本地判定：随机插话前先问本机 Ollama（默认 `qwen2.5:3b`）「这条值不值得接」，
判 NO 就直接记一条活动日志返回，**不创建 DSH 会话、不花 token**。

- 调度：`src/bridge.js` 的 `localTriageSpeak()` / `localTriageCfg()`
- 强制唤醒（@、叫名字、关键词、拍一拍）不经过它，行为与上游一致
- 模型超时/挂掉一律 fail-open（照旧唤醒），不会把机器人变成哑巴
- 自带调试口：`POST /api/debug/triage {key,text}` → `{speak, ms}`，不用真发消息就能验
- 默认只喂「新消息」不喂群历史：实测带上无关闲聊历史会把技术提问误判成闲聊
- 开机预热一次，避免首条消息等 13~18 秒加载

实测：20 例回归 100% 正确，热态 39~61ms。

## 2. 省钱：会话上下文轮换（`socialV2.contextRotateTokens`）

桥接会话在 DSH 里不会被压缩，一条会话跑一天能长到 30 万 token，之后每一步都在重付这笔输入费。
现在 `ensureSession()` 会在上下文超过阈值（默认 60000）时先 `retireSession()` 再建一条新会话，
并把「每回合最多几次工具调用」写进唤醒提示词。

## 3. 记忆与角色

- `roles/*.md` 角色卡 + `POST /api/role` 热切换（改完下一条消息生效，不用重启）
- 群聊静默时段：`offline-notice.mjs down|up`（配合计划任务实现「8 点下班、18 点上班」）

## 4. 语音：念 + 唱

- `POST /api/socialV2/send-voice-text` + MCP 工具 `qq_send_voice_text`：任意文字用 Edge TTS 念出来
  （免费，默认 `zh-CN-XiaoyiNeural`）
- `POST /api/socialV2/sing` + MCP 工具 `qq_sing`：warble + DiffSinger 声库真唱（纯 ONNX，CPU 可跑）
- 预览脚本 `tts-edge.py`，不依赖桥接也能单独出一段语音

## 5. 搜图 / 搜新闻 / 站内搜索

`src/mcp-web-search-safe.js`：`web_image_search` 改为百度图片优先、Bing 兜底（Bing 对中文二次元查询
经常跑偏）；`web_search` 支持百度/搜狗/360/搜狐与 `site:` 限定；`web_fetch` 会自动跟随搜索结果的
JS 跳转外壳页。

## 6. 运维：真的会自己恢复

- `start-qq-bridge.ps1`：探测 DSH 真实 Web 端口（要求响应带 `__DSH_BOOT__`，因为 DSH 的子进程
  也会开 loopback 端口并返回 200，指错端口会让事件流静默断掉）、同步 `baseUrl`、清理陈旧实例
- `ensure-bridge.ps1`：一分钟一次的守卫，**只在 DSH 运行时**才拉起桥接（DSH 关了就不刷窗、不重启）
- `_bridge-launch.ps1`：WMI 分离启动时补 `USERPROFILE`，否则 Node 把家目录算成
  `C:\Windows\system32`，读不到 `.credentials.yaml` → DSH 鉴权永远失败
- `check.ps1`：只读自检，一眼看出是环境问题还是代码问题

## 没有改的

协议层、Cookie 鉴权、mux 事件流、preset 隔离、消息去重、发送限流（只在 429 时补了「还要等几分钟」的
具体文案）都保持上游实现。`docs/` 里的上游文档原样保留。

## 许可

MIT，与上游一致；`LICENSE` 里的版权声明保留原作者。
