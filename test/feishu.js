/* 飞书适配器离线测试：卡片构建、降级、入站解析、去重。
 * 不联网、不需要真实凭据。运行：node test/feishu.js
 */
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    const channel = { appendLine() {}, show() {}, dispose() {} };
    return {
      window: { createOutputChannel: () => channel },
      workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { FeishuAdapter, extractText } = require('../out/feishu/adapter.js');

const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

(async () => {
  // ---- 入站文本解析 ----
  const textMessage = extractText(JSON.stringify({ text: '@_user_1 你好，帮我看看' }), 'text');
  if (textMessage !== '你好，帮我看看') fail(`text 解析错误: ${JSON.stringify(textMessage)}`);

  const postMessage = extractText(
    JSON.stringify({
      title: '标题',
      content: [[{ tag: 'text', text: '第一行' }, { tag: 'text', text: '续' }], [{ tag: 'text', text: '第二行' }]],
    }),
    'post',
  );
  if (postMessage !== '标题\n第一行续\n第二行') fail(`post 解析错误: ${JSON.stringify(postMessage)}`);

  const localizedPost = extractText(
    JSON.stringify({ zh_cn: { title: 'T', content: [[{ tag: 'text', text: '内容' }]] } }),
    'post',
  );
  if (localizedPost !== 'T\n内容') fail(`多语言 post 解析错误: ${JSON.stringify(localizedPost)}`);

  // ---- 入站事件与去重 ----
  const inbound = [];
  const adapter = new FeishuAdapter('cli_0123456789abcdef', 'secret', (message) => inbound.push(message));
  const event = (messageId, text) => ({
    event: {
      message: { message_id: messageId, chat_id: 'oc_test', message_type: 'text', create_time: '1700000000000', content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: 'ou_test' } },
    },
  });
  adapter.handleEvent(event('m1', '第一条'));
  adapter.handleEvent(event('m1', '第一条'));
  adapter.handleEvent(event('m2', '第二条'));
  if (inbound.length !== 2) fail(`事件去重失败，收到 ${inbound.length} 条`);
  if (inbound[0].openId !== 'ou_test' || inbound[0].chatId !== 'oc_test') fail('入站字段提取错误');
  if (inbound[1].text !== '第二条') fail('入站文本错误');

  // ---- 卡片发送：分段 ----
  const calls = [];
  adapter.client = {
    im: {
      message: {
        create: async (payload) => {
          calls.push(payload);
          return { code: 0, data: { message_id: 'x' } };
        },
      },
    },
  };
  const longText = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段：${'内容'.repeat(40)}`).join('\n\n');
  await adapter.sendMarkdown('oc_test', '长文测试', longText, 'blue');
  if (calls.length < 2) fail(`长文未分段，实际 ${calls.length} 条`);
  const first = JSON.parse(calls[0].data.content);
  if (first.schema !== '2.0') fail('未使用卡片 2.0');
  if (calls[0].data.msg_type !== 'interactive') fail('msg_type 错误');
  if (calls[0].params.receive_id_type !== 'chat_id') fail('receive_id_type 错误');
  const joined = calls
    .map((call) => {
      const card = JSON.parse(call.data.content);
      return card.body.elements[0].content;
    })
    .join('');
  if (!joined.includes('第 1 段') || !joined.includes('第 120 段')) fail('分段后内容丢失');
  if (calls.some((call) => call.data.content.length > 30000)) fail('单卡片内容过大');

  // ---- 卡片失败降级为文本 ----
  const textCalls = [];
  adapter.client = {
    im: {
      message: {
        create: async () => {
          throw new Error('card not supported');
        },
      },
    },
  };
  adapter.sendText = async (chatId, text) => {
    textCalls.push({ chatId, text });
  };
  await adapter.sendMarkdown('oc_test', '降级测试', '**加粗** 内容', 'blue');
  if (textCalls.length === 0) fail('卡片失败后未降级为文本');
  if (!textCalls[0].text.includes('降级测试')) fail('降级文本缺少标题');

  console.log(JSON.stringify({ cards: calls.length, inbound: inbound.length, textFallback: textCalls.length }, null, 2));
  console.log('\nPASS: 飞书适配器离线用例全部通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
