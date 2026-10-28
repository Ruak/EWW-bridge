# EWW Bridge

Stream your active **VS Code Copilot Chat** session to **Feishu / Lark** as a live card — and send new tasks from Feishu back into the same chat session.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> Chinese quick start: [中文说明](#中文说明)

---

## What it does

```
Copilot Chat ──realtime──▶ chatSessions / transcripts ──▶ EWW Bridge ──▶ Feishu card
      ▲                                                                     │
      └────────────── workbench.action.chat.open ◀──── Feishu message ◀─────┘
```

- **Outbound**: every assistant turn is mirrored to a Feishu card. The card is created instantly as a placeholder, then patched in place while the answer streams.
- **Inbound**: reply to the bot in Feishu and the text is appended to the *current* Copilot chat session and submitted.
- No public callback URL, no tunnel: Feishu **long connection (WebSocket)** is used.
- Does not modify Copilot or your model provider.

## Features

| | |
|---|---|
| Live streaming | Card patched in place, one in-flight API call per card (latest frame wins) |
| Bidirectional | Feishu → current chat session, with an injection queue |
| Progress hints | Tool activity shown as plain-language lines (`正在编辑文件`, `正在执行命令` …) |
| Interruption aware | Automatically releases the queue when a turn is cancelled by VS Code |
| Reload safe | Card id + request index persisted; a reload keeps patching the same card |
| Feishu-friendly formatting | Headings → bold, tables → bullets, code blocks → compact placeholder, local `file://` links → readable paths |
| No thinking noise | `forward.thinking` defaults to `false`; enable it for a collapsed thoughts panel |
| Secure | App secret in VS Code SecretStorage, open_id allowlist, optional command prefix |

## Requirements

- VS Code **1.95+** with the built-in Copilot Chat
- A Feishu/Lark **self-built app** with the bot capability (see below)

## Install

- **Marketplace**: search for `EWW Bridge`
- **VSIX**: `code --install-extension eww-bridge-x.y.z.vsix`
- **Source**: `npm install && npm run compile && npm run package`

## Feishu app setup (one time)

1. [Feishu Open Platform](https://open.feishu.cn/app) → create a **self-built app**.
2. **Add app capability** → enable **Bot**.
3. **Permissions** → import:

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:chat:readonly",
      "im:resource"
    ]
  }
}
```

4. **Events** → subscribe `im.message.receive_v1`, delivery method **long connection**.
5. Publish the app, then in VS Code run `EWW Bridge: 设置飞书应用凭据` (App ID + App Secret).
6. Run `EWW Bridge: 设置默认推送会话` and pick the chat/group to mirror into.

## Commands

| Command | Description |
|---|---|
| `EWW Bridge: 设置飞书应用凭据` | Store App ID / App Secret |
| `EWW Bridge: 连接飞书` / `断开飞书` | Start / stop the long connection |
| `EWW Bridge: 显示状态` | Connection, session, queue, target chat |
| `EWW Bridge: 发送测试消息` | Send a test card |
| `EWW Bridge: 设置默认推送会话` | Choose the destination chat |
| `EWW Bridge: 显示日志` | Open the output channel |
| `EWW Bridge: 解析当前会话(调试)` | Dump the parsed session summary |
| `EWW Bridge: 模拟飞书下发(注入当前会话)` | Test inbound injection |

The output channel also logs card updates with `(+XXms)` API round-trip timings.

## Chat commands (sent from Feishu)

| Message | Effect |
|---|---|
| any text | Injected into the current chat session |
| `/status` | Bridge + session status |
| `/stop` | Cancel the running turn |
| `/new` | Start a new chat session |
| `/clear` | Drop queued (not running) tasks |
| `/help` | Command list |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ewwBridge.enabled` | `true` | Enable the bridge |
| `ewwBridge.feishu.appId` | — | Feishu app id (`cli_…`) |
| `ewwBridge.feishu.defaultChatId` | — | Target chat id (`oc_…`) |
| `ewwBridge.forward.userMessages` | `true` | Mirror prompts |
| `ewwBridge.forward.assistantMessages` | `true` | Mirror answers |
| `ewwBridge.forward.streaming` | `true` | Live card updates |
| `ewwBridge.forward.streamingIntervalMs` | `500` | Minimum interval between card patches |
| `ewwBridge.forward.thinking` | `false` | Mirror reasoning (collapsed panel) |
| `ewwBridge.forward.progress` | `true` | Show recent tool activity |
| `ewwBridge.forward.toolCalls` | `false` | Show full tool list |
| `ewwBridge.security.allowedOpenIds` | `[]` | open_id allowlist (empty = deny all) |
| `ewwBridge.security.prefix` | `""` | Optional command prefix, e.g. `#ai` |
| `ewwBridge.inject.newChat` | `false` | Start a new session per task |
| `ewwBridge.inject.timeoutMs` | `900000` | Max wait for a turn to finish |

See `settings.example.jsonc`.

## Rendering mapping (VS Code → Feishu card)

| Markdown | Feishu card |
|---|---|
| `# Heading` | bold line |
| pipe tables | bold header + bullet rows |
| fenced code (incl. unclosed) | `〔ts 代码 12 行已省略〕` |
| empty fences (edit placeholders) | dropped |
| inline code | backticks removed, text kept |
| `[file](file:///…)` | link text only (Feishu cannot open local files) |
| `https://…` links | kept clickable |
| emoji | stripped by default (your own messages keep them) |

Cards are capped at 24 KB of UTF-8 JSON and shrink automatically to stay under Feishu limits.

## Security & privacy

- App secret is stored with VS Code **SecretStorage**, never in settings or logs.
- Inbound messages are rejected unless the sender's `open_id` is in `security.allowedOpenIds`.
- Everything runs locally; only card/text payloads are sent to Feishu.
- Recommended: set `security.prefix` so unrelated messages in the chat are ignored.

## Troubleshooting

- **Not connected**: check the log (`EWW Bridge: 显示日志`), app published, long connection enabled, `im.message.receive_v1` subscribed.
- **No cards**: ensure a default chat id is set and the bot is in that chat.
- **Slow updates**: model first-token latency dominates (can be tens of seconds); the card shows `已等待 Ns…` heartbeats meanwhile. Feishu patch round-trip is ~0.6–1.2 s.
- **Truncated look**: oversized cards shrink automatically; the footer shows model and elapsed time.

## Known limitations

- One VS Code window per Feishu app: multiple windows share the same app connection and Feishu load-balances events. Multi-project routing is planned.
- Copilot Chat runs one request per session, so tasks are queued, not parallel.
- Injection relies on built-in workbench commands; a hidden chat webview may delay submission by seconds.

## Development

```bash
npm install
npm run compile
npm test
npm run package
# one-time: vsce login <publisher>
npm run publish -- --patch
```

Update `publisher` in `package.json` to your own Marketplace publisher id before publishing.

## 中文说明

把当前 VS Code 里 Copilot Chat 的会话实时镜像到飞书卡片，并支持从飞书直接给当前会话下发任务。

**快速上手**

1. 飞书开放平台创建「企业自建应用」→ 开启机器人 → 导入上文权限 → 事件订阅选「长连接」并订阅 `im.message.receive_v1` → 发布应用
2. VS Code 执行 `EWW Bridge: 设置飞书应用凭据`（App ID/Secret），再执行 `EWW Bridge: 设置默认推送会话`
3. 在飞书里直接发消息即可；`/status` `/stop` `/new` `/clear` 为内置指令
4. 安全：务必配置 `ewwBridge.security.allowedOpenIds`，建议同时设置 `security.prefix`（如 `#ai`）

**行为说明**

- 每条提问先发占位卡，回答边生成边更新同一张卡
- 默认不转发思考过程；`forward.thinking: true` 可开启折叠面板
- 代码块统一变成「〔代码 N 行已省略〕」，空代码块（编辑占位）直接丢弃
- 卡片超过 24KB 会自动缩容，避免飞书 400/500
- 同一提问只投递一次，不会因自动重投产生重复消息

## License

MIT © EWW Bridge contributors
