# EWW Bridge

Stream your active **VS Code Copilot Chat** session to **Feishu / Lark** as a live card — and send new tasks from Feishu back into the same chat session.

[![Marketplace](https://img.shields.io/badge/marketplace-EWW%20Bridge-blue)](https://marketplace.visualstudio.com/items?itemName=huangdan.eww-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE))

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
| One card per question | A turn owns exactly one card; stray placeholders are recycled instead of staying at `进行中…` |
| Deterministic card state | Title/footer follow the whole turn: `处理中…` while running, `已完成 · Ns` only at the end, `已停止` when cancelled in VS Code — tool steps never flip it back and forth |
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

- **Marketplace**: search for `EWW Bridge` or install `huangdan.eww-bridge`
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
| `EWW Bridge: 给内置 Copilot 打即时落盘补丁（推荐）` | Make Copilot flush its transcript immediately (see below) |
| `EWW Bridge: 还原内置 Copilot 落盘补丁` | Restore the original Copilot bundle |
| `EWW Bridge: 兼容性自检（VS Code 升级后用）` | Report whether every assumption still holds |

The output channel also logs card updates with `(+XXms)` API round-trip timings.

## Copilot flush patch (recommended)

VS Code buffers Copilot's chat transcript in memory and only writes it out when the *next* event
arrives, so during long background steps (e.g. a slow terminal command) the card can look frozen for
tens of seconds. The patch wraps `SessionTranscript._bufferEntry` so every event is flushed right away.

- Run `EWW Bridge: 给内置 Copilot 打即时落盘补丁（推荐）` from the Command Palette, then reload the window.
- First activation shows a one-time prompt if the patch is missing.
- The patch backs up the bundle to `extension.js.eww-orig` and syntax-checks the result before writing;
  `EWW Bridge: 还原内置 Copilot 落盘补丁` rolls back.
- **VS Code updates overwrite the bundle** — the extension detects it and offers the patch again.
- Needs write access to the VS Code install dir. If VS Code lives in `Program Files`, run VS Code as
  administrator once, or run the bundled script from an elevated terminal:

```bash
node "<extension dir>/scripts/patch-copilot-flush.js"            # patch
node "<extension dir>/scripts/patch-copilot-flush.js" --check    # status
node "<extension dir>/scripts/patch-copilot-flush.js" --restore  # rollback
node "<extension dir>/scripts/patch-copilot-flush.js" --path <extension.js>
```

The script lives at `<extension dir>/scripts/patch-copilot-flush.js` (shipped inside the VSIX) and
auto-detects the newest VS Code install, including versioned layouts such as
`…/Microsoft VS Code/<hash>/resources/app/extensions/copilot/dist/extension.js`.

This is optional: without it EWW still works, cards just update less promptly during long tool steps.

## After a VS Code upgrade

Upgrading VS Code can break internals this extension relies on. What happens automatically vs. what
needs an update:

| Layer | Behaviour after upgrade |
|---|---|
| Copilot install path (new `<hash>` dir) | Self-healing: candidates are walked and the **newest** `extension.js` wins |
| Flush patch | Overwritten by the upgrade → status becomes `clean` and the one-time prompt returns; re-run the patch |
| Patch anchors | Matched by **regex** on `_bufferEntry(...){let x=this._activeSessions.get(...)}` / `async flush(...)`, so minifier variable renames do not break it. If the structure really changes, the patch refuses to write and asks for a report |
| Transcript / agent event schema | Not self-healing — `EWW Bridge: 兼容性自检` probes the tail of the newest transcript for known event types |
| `chatSessions` patch-stream format (`kind0/1/2`) | Not self-healing — the compat report checks the directory and newest file |
| `workbench.action.chat.*` commands | Stable in practice; if injection stops working the compat report will not catch it |

Run `EWW Bridge: 兼容性自检（VS Code 升级后用）` after every VS Code or Copilot update. It prints
versions, patch state, session directories, event-type counts and a one-line verdict to the log
(`EWW Bridge: 显示日志`), and lists anything that needs adapting.

## Chat commands (sent from Feishu)

| Message | Effect |
|---|---|
| any text | Injected into the current chat session |
| `/status` | Bridge + session status |
| `/stop` | Cancel the running turn (the card ends as `Copilot · 已停止`) |
| `/new` | Start a new chat session |
| `/clear` | Drop queued (not running) tasks |
| `/help` | Command list |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ewwBridge.enabled` | `true` | Enable the bridge |
| `ewwBridge.copilotExtensionFile` | — | Manual path to Copilot's `extension.js` (only if auto-detect fails) |
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

## Localization

- **Extension UI follows VS Code's display language**: command titles and setting descriptions ship in
  English (`package.nls.json`, default) and Simplified Chinese (`package.nls.zh-cn.json`).
- **Feishu card labels stay Chinese** (`Copilot · 处理中…`, `已完成 · Ns`, `Copilot · 已停止` …) so a card looks
  the same for every teammate in the chat — see [Card state](#card-state-title-and-footer).
- Logs stay Chinese to match the existing troubleshooting guide.

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

### Card state (title and footer)

Card labels are Chinese, matching the VS Code UI language used by the bridge:

| Stage | Card shows |
|---|---|
| Turn running | title `Copilot · 处理中…` plus a status line (`正在执行 view：src/app.ts`, `进行中…（已等待 42s）`, …) |
| Turn finished | title `Copilot`, footer `已完成 · 42s` |
| Stopped in VS Code | title `Copilot · 已停止`, footer `已停止 · 12s`; text produced so far is kept |
| Interrupted by a new prompt | title `Copilot · 已中断` (best effort — only when the card has been idle ≥15 s; otherwise the previous card is simply released) |

The title/footer are derived from *the turn as a whole*, not from individual model steps:
`assistant.turn_end` fires after **every** model message, so per-step rendering used to flip
the card between “in progress” and “done” on every tool call.

## Security & privacy

- App secret is stored with VS Code **SecretStorage**, never in settings or logs.
- Inbound messages are rejected unless the sender's `open_id` is in `security.allowedOpenIds`.
- Everything runs locally; only card/text payloads are sent to Feishu.
- Recommended: set `security.prefix` so unrelated messages in the chat are ignored.

## Troubleshooting

- **Not connected**: check the log (`EWW Bridge: 显示日志`), app published, long connection enabled, `im.message.receive_v1` subscribed.
- **No cards**: ensure a default chat id is set and the bot is in that chat.
- **Two cards for one question**: one turn must own exactly one card. If an extra card is stuck at `进行中…（已等待 Ns）` next to a finished answer, an older build mixed the agent-session id (`events`) with the chat-session id — upgrade to 1.1.2 or later and reload the window.
- **Card stuck at `进行中…` after stopping**: cancelling a turn right after sending produces an `abort` event with no assistant text. 1.1.4+ finalizes that card as `Copilot · 已停止`; older builds left it running forever — upgrade and reload.
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
5. **推荐**：执行 `EWW Bridge: 给内置 Copilot 打即时落盘补丁（推荐）`，然后重载窗口（详见下节）

**内置 Copilot 落盘补丁（可选，但强烈建议）**

VS Code 把 Copilot 的会话记录缓存在内存里，要等下一条事件才写盘；后台长命令期间飞书卡片可能看起来“卡住”。补丁让每条事件立即落盘，卡片才能真流式。

- 命令面板执行 `EWW Bridge: 给内置 Copilot 打即时落盘补丁（推荐）` → 提示重载窗口
- 没打过补丁时，插件首次激活会弹一次提示（每个 VS Code 版本最多一次）
- 补丁自动备份为 `extension.js.eww-orig` 并做语法校验；`EWW Bridge: 还原内置 Copilot 落盘补丁` 可还原
- **VS Code 升级会覆盖该文件**，插件会重新提示；也可手动跑随插件发布的脚本：
  `node "<插件目录>/scripts/patch-copilot-flush.js"`（`--check` / `--restore` / `--path`）
- VS Code 装在 `Program Files` 时需要管理员权限：用管理员身份启动一次 VS Code，或用管理员终端运行上面的脚本

**VS Code / Copilot 升级后**

- 安装目录换了新的 `<hash>` 子目录：插件会自动找到最新的那个，无需手动改
- 补丁会被升级覆盖：状态变回「未打」，插件会再提示一次，重新打即可
- 补丁锚点已改成**正则匹配**（变量名被改成 `t/i/s` 也不影响）；如果结构真变了，补丁会拒绝写入而不是写坏
- 执行 `EWW Bridge: 兼容性自检（VS Code 升级后用）`：会打印版本、补丁状态、会话目录、事件类型命中情况与结论，明确指出哪一层需要适配（详情在日志）

**行为说明**

- 每条提问先发占位卡，回答边生成边更新同一张卡
- **卡片状态**（标题/底部只由“整轮”决定，不看单步事件）：
  - 整轮进行中：`Copilot · 处理中…` + 状态行（`正在执行 view：src/app.ts`、`进行中…（已等待 42s）` 等）
  - 整轮结束：`Copilot` + `已完成 · 42s`
  - 在 VS Code 侧停止：`Copilot · 已停止` + `已停止 · 12s`（已产出的正文保留）
  - 被新消息打断：`Copilot · 已中断`（尽力而为：仅当卡片已静默 ≥15s 才会改写，否则直接释放上一张卡）
  - `assistant.turn_end` 是**每条模型消息**结束时都会触发的事件，所以工具调用的每一步结束都不会把卡片刷成“已完成”
- 同一次提问永远只有一张卡片：会话标识发生变化时会回收遗留的空占位卡，不会留下一直显示“进行中”的多余卡片
- 默认不转发思考过程；`forward.thinking: true` 可开启折叠面板
- 代码块统一变成「〔代码 N 行已省略〕」，空代码块（编辑占位）直接丢弃
- 卡片超过 24KB 会自动缩容，避免飞书 400/500
- 同一提问只投递一次，不会因自动重投产生重复消息
- 插件命令与设置说明跟随 VS Code 显示语言：英文（默认）与简体中文各一份（`package.nls.json` / `package.nls.zh-cn.json`）；
  飞书卡片文案与日志固定中文

## License

MIT © EWW Bridge contributors
