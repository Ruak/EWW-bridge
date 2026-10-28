import * as lark from '@larksuiteoapi/node-sdk';
import { log, logError } from '../log';
import { buildCardV1, buildCardV2, normalizeMarkdownForFeishu, splitMarkdown, truncateForText } from './card';
import type { CardPair } from './card';

export interface InboundMessage {
  openId: string;
  chatId: string;
  messageId: string;
  messageType: string;
  text: string;
  createTime?: number;
}

const ANY = lark as any;

export class FeishuAdapter {
  started = false;
  private client: any;
  private ws: any;
  private seen = new Set<string>();
  private patchSupported = true;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly onInbound: (message: InboundMessage) => void,
  ) {
    this.client = new ANY.Client({
      appId,
      appSecret,
      appType: ANY.AppType?.SelfBuild ?? 0,
      domain: ANY.Domain?.Feishu,
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    if (!/^cli_[0-9a-fA-F]{16}$/.test(this.appId)) {
      throw new Error(`App ID 格式无效：${this.appId}（应为 cli_ + 16 位十六进制）`);
    }
    const dispatcher = new ANY.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          this.handleEvent(data);
        } catch (error) {
          logError('feishu inbound failed', error);
        }
        return { code: 0 };
      },
    });
    this.ws = new ANY.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: ANY.LoggerLevel?.warn ?? 2,
    });
    this.ws.start({ eventDispatcher: dispatcher });
    this.started = true;
    log('feishu: long-connection started');
  }

  stop(): void {
    try {
      this.ws?.close?.();
      this.ws?.stop?.();
    } catch (error) {
      logError('feishu stop failed', error);
    }
    this.ws = undefined;
    this.started = false;
    log('feishu: stopped');
  }

  /** WebSocket 真实状态：connected / connecting / reconnecting / failed / idle */
  connectionState(): string {
    if (!this.ws) {
      return 'stopped';
    }
    try {
      return this.ws.getConnectionStatus?.()?.state ?? 'idle';
    } catch {
      return 'idle';
    }
  }

  async sendMarkdown(chatId: string, title: string, markdown: string, template: any = 'blue', keepEmoji = false): Promise<void> {
    const normalized = normalizeMarkdownForFeishu(markdown, { keepEmoji });
    const chunks = splitMarkdown(normalized);
    if (chunks.length === 0) {
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      const partTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
      const messageId = await this.sendCard(chatId, partTitle, chunks[i], template);
      if (!messageId) {
        await this.sendText(chatId, `【${partTitle}】\n${truncateForText(chunks[i])}`);
      }
    }
  }

  /** 发送卡片并返回 message_id（流式后续 patch 需要） */
  async sendCardReturningId(chatId: string, title: string, markdown: string, template: any = 'blue'): Promise<string | undefined> {
    return this.sendCard(chatId, title, markdown, template);
  }

  /** 发送 v2 卡片（含折叠面板），失败自动降级 v1 */
  async sendCardPair(chatId: string, pair: CardPair): Promise<string | undefined> {
    for (const content of [pair.v2, pair.v1]) {
      try {
        const response: any = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
        if (response && typeof response.code === 'number' && response.code !== 0) {
          throw new Error(`code=${response.code} msg=${response.msg}`);
        }
        const messageId = response?.data?.message_id;
        if (typeof messageId === 'string') {
          return messageId;
        }
      } catch (error) {
        logError('feishu sendCardPair attempt failed', error);
      }
    }
    return undefined;
  }

  /** 更新卡片：优先 v2（折叠面板），失败降级 v1 */
  async patchCardPair(messageId: string, pair: CardPair): Promise<boolean> {
    if (!this.patchSupported || !messageId) {
      return false;
    }
    for (const content of [pair.v2, pair.v1]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response: any = await this.client.im.message.patch({
            path: { message_id: messageId },
            data: { content },
          });
          if (response && typeof response.code === 'number' && response.code !== 0) {
            throw new Error(`code=${response.code} msg=${response.msg}`);
          }
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/permission|scope|403|99991672|99991663|no.?authority/i.test(message)) {
            this.patchSupported = false;
            log('feishu: 卡片更新不可用（请确认已开通 im:message:update 权限），后续仅发送最终结果');
            return false;
          }
          const transient = /status code 5\d\d|ECONNRESET|ETIMEDOUT|timeout/i.test(message);
          if (transient && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          logError('feishu patchCardPair attempt failed', error);
          break;
        }
      }
    }
    return false;
  }

  /** 更新已发送的卡片（流式输出） */
  async patchCard(messageId: string, markdown: string, title: string, template: any = 'blue'): Promise<boolean> {
    if (!this.patchSupported || !messageId) {
      return false;
    }
    const attempts = [
      () => buildCardV2(markdown, { title, template }),
      () => buildCardV1(markdown, { title, template }),
    ];
    for (const build of attempts) {
      try {
        const response: any = await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: build() },
        });
        if (response && typeof response.code === 'number' && response.code !== 0) {
          throw new Error(`code=${response.code} msg=${response.msg}`);
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/permission|scope|403|99991672|99991663|no.?authority/i.test(message)) {
          this.patchSupported = false;
          log('feishu: 卡片更新不可用（请确认已开通 im:message:update 权限），后续仅发送最终结果');
          return false;
        }
        logError('feishu patchCard attempt failed', error);
      }
    }
    return false;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const chunks = splitMarkdown(text, 6000);
    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (error) {
        logError('feishu sendText failed', error);
      }
    }
  }

  private async sendCard(chatId: string, title: string, markdown: string, template: any): Promise<string | undefined> {
    const attempts = [
      () => buildCardV2(markdown, { title, template }),
      () => buildCardV1(markdown, { title, template }),
    ];
    for (const build of attempts) {
      try {
        const response: any = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: build(),
          },
        });
        const messageId = response?.data?.message_id;
        if (response && typeof response.code === 'number' && response.code !== 0) {
          throw new Error(`code=${response.code} msg=${response.msg}`);
        }
        if (typeof messageId === 'string') {
          log(`feishu: card sent ${messageId.slice(-8)} (${build().length}ch, ${title})`);
          return messageId;
        }
        return undefined;
      } catch (error) {
        logError('feishu sendCard attempt failed', error);
      }
    }
    return undefined;
  }

  private handleEvent(data: any): void {
    const event = data?.event ?? data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message || !sender) {
      return;
    }
    const messageId = message.message_id || '';
    const openId = sender.sender_id?.open_id || '';
    const chatId = message.chat_id || '';
    if (!openId || !chatId) {
      return;
    }
    if (messageId) {
      if (this.seen.has(messageId)) {
        return;
      }
      this.seen.add(messageId);
      if (this.seen.size > 500) {
        const first = this.seen.values().next().value;
        if (first) {
          this.seen.delete(first);
        }
      }
    }
    const text = extractText(message.content, message.message_type);
    log(`feishu: inbound ${message.message_type} from ${openId.slice(0, 12)}… text=${JSON.stringify(text.slice(0, 60))}`);
    this.onInbound({
      openId,
      chatId,
      messageId,
      messageType: message.message_type || 'text',
      text,
      createTime: Number(message.create_time) || undefined,
    });
  }
}

export function extractText(content: string, messageType: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(content || '{}');
  } catch {
    return '';
  }
  let text = '';
  if (messageType === 'text') {
    text = parsed.text || '';
  } else if (messageType === 'post') {
    const body = parsed.content ? parsed : parsed.zh_cn || parsed.en_us || parsed.ja_jp || {};
    const lines: string[] = [];
    if (typeof body.title === 'string' && body.title.trim()) {
      lines.push(body.title.trim());
    }
    const rows: any[][] = Array.isArray(body.content) ? body.content : [];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }
      const line = row.map((segment) => (segment && typeof segment.text === 'string' ? segment.text : '')).join('');
      if (line.trim()) {
        lines.push(line);
      }
    }
    text = lines.join('\n');
  }
  return stripMentions(text);
}

function stripMentions(text: string): string {
  return text
    .replace(/@_user_\d+/g, '')
    .replace(/@_all/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
