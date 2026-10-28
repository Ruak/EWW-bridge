# Changelog

All notable changes to **EWW Bridge** are documented here.

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
