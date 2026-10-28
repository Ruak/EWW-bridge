# Changelog

All notable changes to **EWW Bridge** are documented here.

## 1.0.15

- **“不知哪来的消息乱入”真因修复**：会话文件 312MB 时只能尾部解析，`requests` 是**稀疏数组**、下标与真实回合号完全对不上（日志里尾部最大下标只有 272，而实际已到 4xx）。启动时把“最后一条”当成未完成回合重放 → 卡片被三小时前的 `#272`（1052ch）覆盖，真实新回合的 530ch 反被回退守卫拦下，表现就是“乱入 + 不同步”
  - `SessionWatcher.partialState`：大文件尾部解析后标记为残缺态，**禁止历史重放**、禁用 chatSessions 驱动的出站，完全改由 transcript（实时、逐行、无快照）驱动
  - `isBusy()` 跳到最后一条**真实存在**的请求，不再把数组末尾的空洞当成“未完成”而永远忙
  - 残缺态下后续补丁继续用宽松模式，避免新回合补丁因旧路径缺失被静默丢弃
- **重载不再只剩后半段**：transcript 附加时从最后一次真实 `user.message` 回看（最多 4MB）并静默摄入，重载后本轮已有正文能立即重建
- **会话抢占修复**：当前会话 2 分钟内有写入时，不会被其它聊天标签页/后台会话的文件抢占镜像
- 新增回归测试 `test/partial.js`

## 1.0.14

- **写者锁改为按项目隔离**：原先锁文件是全局唯一的（`bridge-owner.json`），先打开的那个窗口会把所有其它窗口全部置为被动，导致“另一个窗口显示被当前项目接管、无法启用”
  - 锁文件名改为 `bridge-owner-<scopeHash>.json`，scope = 当前工作区文件夹路径
  - 同一项目的多个窗口仍然只允许一个写者（避免同一张卡片被覆盖）；不同项目各自推送自己的聊天与飞书目标，互不影响
  - 状态栏与命令提示明确写出“同一个项目已被某个窗口接管”

## 1.0.13

- **VS Code 侧消息被截断的真因修复**：注入器旧逻辑在“当前回合仍在跑”时就提交（`waitUntilIdle` 60s 超时后强行投递，或 transcript 静默 8s 就以为空闲），而 `chat.open` 提交会打断 VS Code 正在输出的回合 —— 被中断的答复落盘后就是残段，重载窗口后只能看到这一部分
  - 新增 `TranscriptWatcher.isTurnRunning()`（`turn_start`/`user.message` 未闭合，或 `tool.execution_inflight>0`，长终端命令也计入）
  - 注入前必须同时满足：无在途回合、无在途工具、静默 ≥ 2s（transcript 静默 >30s 时不再理会 chatSessions 的滞后 `isBusy`）；未空闲则**继续排队**，绝不强行提交
- **结束判定改用实时源**：`waitForTurnEnd` 以 transcript（turn 闭合 + 无在途工具 + 静默 3s）为主，chatSessions 的 `result` 只作辅证，不再“要等超时才知道结束”
- **重载不再掉正文**：卡片状态额外持久化已渲染正文（≤12k 字符）与已渲染长度；恢复后任何更短的残段都会被丢弃（`跳过回退帧`），并回写 workspaceState

## 1.0.12

- **多实例单写者锁**：同一台机器多个窗口都装了本扩展时，只允许一个实例镜像/推送（globalStorage 锁 + 5s 心跳 + pid 存活检查）；其余窗口进入被动模式，状态栏显示“飞书(已接管)”
- **日志带实例前缀**（`[w:xxxxxxxx]` / `[p:xxxxxxxx]`），再也不会分不清是谁在写卡片
- **回合结束改为 transcript 优先**：`turn_end` + 静默 1.5s + 无在途工具即认为结束，不再死等 chatSessions 的 `result`（它往往晚 30s+），注入队列不再“等超时”
- **长任务进展可见**：`tool.execution_start` 立即把卡片刷成「正在执行 run_in_terminal：npm test（已 Ns）」，心跳 5s 常驻，终端跑再久也不会看起来像卡住
- **patch 节流**：同一张卡最小间隔 1.2s，降低飞书限频造成的丢帧（日志里 `soft finalize FAIL → ok`）
- 新增回归测试 `test/instance.js`（第二个实例必须进入被动模式）

## 1.0.11

- **同步卡住修复**：重载后尾部解析会碰到几小时前的历史回合迟到落盘（补上 `result`），旧实现把它当成新终稿发出去，把卡片绑定到错误回合，本轮真正的结果反而全部被当“迟到”丢弃 → 新增 `replayFloor`，只允许最后一条请求及其之后的新请求发终稿
- **时间判定修正**：`staleByTime` 容差从 5s 放到 120s，且只在本回合起点确定、时间戳有效时生效；卡片未绑定回合时宁可接受结果，也不再让卡片永远停在“处理中”
- **新建占位卡立即绑定回合下标**（并写入 workspaceState），重载恢复后能可靠拒绝其它回合的结果
- **提问卡片去重**：watcher 先看到提问时也会登记，transcript 迟到不再重复发一张一模一样的提问卡
- 新增回归测试 `test/replay-floor.js`（历史回合不重放 + 正文查询限定回合）

## 1.0.10

- **新回合串上上一轮正文修复**：`latestAnswerText` 不再回退到更早的回合，`mergedAnswer` 必须传入当前回合下标；chatSessions 还没落盘新回合时只用 transcript 文本，卡片不会再渲染上一条回复
- `watcher.onPartial` 增加回合下标校验，上一回合的迟到增量不再写进新卡片

## 1.0.9

- **“上一轮已结束”误报修复**：注入后的结束判定不再依赖“60s 静默”，而是只看该请求的权威状态 —— `result` 出现 = 完成，`elapsedMs=0` 且无 `result` = 中断；静默仅在 5 分钟无任何动静时作兜底
- 新增 `SessionWatcher.latestStatus()`（pending / completed / aborted / unknown），只统计非 terminal-notification 请求

## 1.0.8

- **Final events with no text no longer blank the card.** `chatSessions` often finishes a turn with `text: 0` while the answer only exists in transcripts/soft-final; the final card now carries the last known answer instead of rebuilding an empty “仍在处理” card (this was wiping a 1974-char answer down to 598 bytes of tool labels)
- Fixed `baseline requests=[object Object]` log output

## 1.0.7

- **A new user turn can no longer overwrite the previous answer card.** Cards are released (not reused) as soon as a new prompt arrives and the existing card already has content; the old card is left intact instead of being replaced with a short status card
- Removed the silent rebinding of a content-bearing card to a new request index (the cause of a 1.3k-char answer being replaced by a 24-char reply)

## 1.0.6

- Diagnostics for the remaining latency: every ≥80 char text growth logs `transcript: 正文累计 Nch`, and every ≥80 char card update logs `outbound: 卡片正文 Nch 已发送`. The gap between the two lines is bridge latency; if a text line is missing, the delay is upstream (model/transcript)

## 1.0.5

- **Bounded memory for huge session files**. Measured on a 313 MB `chatSessions` file: full parse took 38.5s and peaked at **2.6 GB** heap (~326 MB settled). Now:
  - Files larger than 8 MB are parsed from a **tail window** with a lenient patch applier (missing paths are created)
  - Parsing is chunked (1 MB reads) and in-flight responses are **compacted**: non-text parts are reduced to `kind` only, old answers are blanked, tool parts keep only their label
  - `emitted` bookkeeping stores a short content signature instead of the full text
  - Result: **~1.1s / 48 MB heap / 90 MB RSS** for the same file
- Patch failures no longer trigger a full-file rebuild (which caused the multi-GB spike); they are skipped and logged at most once per minute

## 1.0.4

- **Removed the sticky `suppressStreamingUntilTurnEnd` flag** that could swallow an entire turn after a mid-turn reload (observed: 3m22s of silence until an unrelated terminal notification cleared it). Streaming now starts from the current progress
- **Answers are merged from both sources**: transcript text and the chatSessions response text, whichever is longer wins (agent mode writes visible text mainly to chatSessions)
- **Turn-end detection** for the queue no longer trusts per-step `assistant.turn_end`; it requires 60s of real silence and no tool in flight (`toolInFlight` counter)
- New `toolInFlight` metric in the transcript watcher with unit coverage

## 1.0.3

- **Removed the 60-update cap** that silently froze the card on long agent turns. Updates are now limited only by content change (and the single-flight queue), so a card can keep streaming for any number of steps
- Patch skips now log their reason (`no messageId` / unchanged content)
- Inbound turn-end detection uses the transcript's new **settled** signal (turn_end + quiet) instead of a 15s silence guess, so long tool runs no longer trigger a false "turn ended"
- Liveness heartbeat (10s) now reuses the last known answer/tool list, so long turns keep showing progress instead of going silent

## 1.0.2

- Background terminal notifications (`[Terminal …]` steering messages) are no longer treated as turn interruptions: transcript keeps accumulating, the streaming card state is preserved, and no spurious "已中断" card/queue release happens
- `chatSessions` requests created by terminal notifications are skipped entirely (no user/assistant/partial events)
- Turn-end detection requires 15s of real transcript silence, so brief `isBusy` flickers during tool loops no longer abort the waiting task

## 1.0.1

- **Logging no longer dies after re-activation**: file logging is written before the output channel and output-channel errors are swallowed (a disposed channel could silently kill all logging)
- Inbound replies now say **已排队：当前回合还在运行** when the target window is busy, instead of always claiming it was submitted

## 1.0.0

First public release on the VS Code Marketplace.

- Bidirectional bridge between the active Copilot Chat session and Feishu/Lark
- Live card streaming with single-flight patching, auto-shrink under Feishu size limits
- Feishu-native formatting (bold headings, bullet tables, code placeholders, readable local paths, emoji stripped)
- Injection queue with single submission (no duplicate prompts), interruption recovery, reload-safe card persistence
- Waiting heartbeats, model/elapsed footer, `forward.thinking` off by default

Everything from 0.21.0 and below is included; see the entries below for the detailed history.

## 0.21.0

- Fix duplicate prompts: injection is submitted **once** (45s confirmation window); auto-retry removed, fallback only when the command itself throws
- Idle detection now uses transcript silence (8s) instead of lagging `chatSessions` state
- Queue-level dedupe: identical pending tasks are ignored

## 0.20.9

- Single-flight card patching: at most one in-flight `im.message.patch` per card, latest frame wins
- Final message waits for in-flight frames before patching, preventing out-of-order overwrites

## 0.20.8

- Delivery confirmation also accepts "card content appeared" as evidence
- Soft-final idle 1.5s → 0.8s; heartbeat 5s → 3s

## 0.20.7

- Waiting heartbeat: placeholder card updates `已等待 Ns…` every 3s while the model has not produced output
- Placeholder wording changed to `处理中`

## 0.20.6

- Thinking forwarding off by default (`forward.thinking: false`)

## 0.20.5

- Card payload capped at 24 KB UTF-8, progressive shrink (thinking → answer → panel)
- Retry once on Feishu 5xx

## 0.20.4

- Fix body being swallowed: VS Code writes an odd number of empty fence markers around file edits; fences are now paired safely and lone markers are dropped without eating prose
- Injection confirmation window widened to 12s/8s

## 0.20.0 – 0.20.3

- Thoughts panel collapsed by default
- Injection confirmation via `userPromptCount`, warm-up before first submission
- Failed delivery no longer blocks the queue
- Card title/status cleaned up (no emoji)
- Fix for empty fence placeholders produced by edits (VS Code edit cards)

## 0.19.0

- Latency: `chat.focusInput` before `chat.open`; short detection windows; idle wait 30s → 8s
- Polling: transcript 400 → 200ms, chatSessions 1000 → 300ms, soft-final 4000 → 1500ms
- `streamingIntervalMs` default 800 → 500; patch logs include round-trip ms

## 0.18.0

- Empty fences from edit steps are dropped
- Stream state survives finalization (`doneAt`), so late complete text patches the same card
- Empty text with thinking/tools is treated as "not final"
- Idle fallback no longer fakes an interruption; permission regex narrowed

## 0.17.0

- Normalization rewrite: fenced blocks parsed line by line (including unclosed), inline code unwrapped, `file://` links reduced to text, emoji stripped

## 0.16.0

- Unified Feishu markdown normalization (headings, tables, rules, HTML, code blocks) and model/elapsed footer

## 0.15.0

- Progress hints, code block stripping, fold-on-answer behavior, faster soft final

## 0.14.0

- Reload no longer truncates the card: persist request index, replay last result into the same card

## 0.13.0

- Persist the streaming card id in workspace state across reloads

## 0.12.0

- Suppress history replay on reload

## 0.11.0

- Clear accumulated transcript on a new user message

## 0.10.0

- Aborted turns release the injection queue; `/clear` added

## 0.9.0

- Interruption handling and queue recovery

## 0.8.0

- Card 2.0 collapsible thoughts panel

## 0.7.0

- Injection: `chat.open { query, isPartialQuery:false }` first

## 0.6.0

- Placeholder card created right after injection

## 0.5.0

- Streaming switched to Copilot Chat transcripts (real-time)

## 0.4.0

- Baseline marks completed requests as emitted

## 0.3.0

- Incremental chatSessions parsing (kind 0/1/2)

## 0.2.0

- Real-time streaming card updates

## 0.1.0

- Initial bridge: outbound mirroring, inbound injection, Feishu long connection
