export interface CardOptions {
  title: string;
  template?: 'blue' | 'green' | 'grey' | 'red' | 'orange' | 'turquoise' | 'violet' | 'wathet' | 'carmine';
}

/** 飞书卡片 2.0（markdown 元素支持代码块） */
export function buildCardV2(markdown: string, options: CardOptions): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: options.title },
      template: options.template || 'blue',
    },
    body: {
      elements: [{ tag: 'markdown', content: markdown }],
    },
  });
}

/** 卡片 1.0 兜底（部分旧客户端不支持 2.0） */
export function buildCardV1(markdown: string, options: CardOptions): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: options.title },
      template: options.template || 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: markdown },
      },
    ],
  });
}

export function splitMarkdown(markdown: string, maxChars = 7000): string[] {
  const text = markdown.trim();
  if (!text) {
    return [];
  }
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) {
      cut = rest.lastIndexOf('\n', maxChars);
    }
    if (cut < maxChars * 0.5) {
      cut = maxChars;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

export interface CardPair {
  v2: string;
  v1: string;
}

export interface StreamingCardOptions {
  title: string;
  template?: string;
  thinking?: string;
  answer?: string;
  tools?: string[];
  status?: string;
  /** true = 思考面板展开（流式中）；false = 折叠（完成后可点击展开） */
  expanded: boolean;
  showThinking?: boolean;
  thinkingLimit?: number;
  answerLimit?: number;
  /** 卡片底部的小字注脚（模型 / 耗时） */
  footer?: string;
}

function buildThoughtPanel(text: string, expanded: boolean): object {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: { tag: 'plain_text', content: '思考过程' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: '', size: '16px 16px' },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: text }],
  };
}

const TOOL_LABELS: Record<string, string> = {
  apply_patch: '正在编辑文件',
  replace_string_in_file: '正在编辑文件',
  multi_replace_string_in_file: '正在编辑多个文件',
  create_file: '正在创建文件',
  read_file: '正在读取文件',
  list_dir: '正在查看目录',
  file_search: '正在查找文件',
  grep_search: '正在搜索代码',
  run_in_terminal: '正在执行命令',
  fetch_webpage: '正在访问网页',
  get_errors: '正在检查错误',
  manage_todo_list: '正在整理任务',
};

function toolLabelForCard(name: string): string {
  return TOOL_LABELS[name] || name;
}

/** 飞书卡片渲染代码块会变成空行：去掉围栏代码块，用占位文字代替 */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[^\n]*\n[\s\S]*?```/g, '〔代码已省略〕')
    .replace(/`{3,}/g, '')
    .trim();
}

/** 常见 emoji / 图形符号（含变体选择符、零宽连接） */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2122}\u{2139}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '');
}

function placeholderForFence(lang: string, rows: number, closed: boolean): string {
  const label = lang ? `${lang} ` : '';
  return closed ? `〔${label}代码 ${rows} 行已省略〕` : `〔${label}代码 ${rows} 行，输出中已省略〕`;
}

/** 围栏内容看起来像正文（而不是代码）时，说明围栏标记是孤立残留 */
/** 一行看起来像自然语言/结构标题（用于识别孤立围栏标记） */
function looksLikeProseLine(line: string): boolean {
  const t = line.trim();
  if (!t) {
    return false;
  }
  if (/^(#{1,6}\s|[-*+]\s|\d+[.、)]\s|>\s|\|)/.test(t)) {
    return true;
  }
  if (/\*\*[^*]+\*\*/.test(t)) {
    return true;
  }
  // 中文自然语言句子（带中文标点且不像代码）
  return /[。，！？；：]/.test(t) && !/[{}();=<>]/.test(t);
}

/** 飞书打不开本地文件链接，把 file:// 地址转成可读路径 */
function prettyUrl(raw: string): string {
  const url = raw.trim().replace(/^</, '').replace(/>$/, '');
  if (!/^(?:file|vscode-file):/i.test(url)) {
    return url;
  }
  let path = url.replace(/^[a-z-]+:\/\/\/?/i, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 保留原样 */
  }
  if (/^\/[a-zA-Z]:/.test(path)) {
    path = path.slice(1);
  }
  return path.replace(/\//g, '\\');
}

/**
 * 把 VS Code 常见 Markdown 转成飞书卡片最忧呈现：
 * - 代码块：不显示内容，改为〔ts 代码 12 行已省略〕
 * - 标题：转粗体行（卡片 markdown 对标题支持不稳定）
 * - 表格：转成“表头 + 项目列表”
 * - 任务列表：保留 [x] / [ ] 文本标记
 * - 分隔线、HTML 标签：转纯文本
 */
export function normalizeMarkdownForFeishu(input: string, options: { keepEmoji?: boolean } = {}): string {
  if (!input) {
    return '';
  }
  let out = input.replace(/\r\n?/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 1) 围栏代码块：先识破 VS Code 空占位块（```+空行+```），再处理真实代码块
  const rawLines = out.split('\n');
  const isMarker = (line: string) => /^\s*(`{3,}|~{3,})\s*$/.test(line);
  const markerMatch = (line: string) => /^\s*(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
  const kept: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const m = markerMatch(rawLines[i]);
    if (!m) {
      kept.push(rawLines[i]);
      continue;
    }
    // 空占位块：两个标记之间只有空行（VS Code 的编辑卡片占位）→ 整块丢弃
    let j = i + 1;
    while (j < rawLines.length && !rawLines[j].trim()) {
      j++;
    }
    if (j < rawLines.length && isMarker(rawLines[j])) {
      i = j;
      continue;
    }
    // 孤立标记（VS Code 空占位块会写出奇数个）后跟的是散文时，只丢标记，保留正文
    if (!m[2].trim() && j < rawLines.length && looksLikeProseLine(rawLines[j])) {
      continue;
    }
    // 真实代码块：向后找闭合标记（未闭合则吃到文末）
    const markerChar = m[1][0];
    const closeRe = new RegExp(`^\\s*\\${markerChar}{${m[1].length},}\\s*$`);
    let k = i + 1;
    while (k < rawLines.length && !closeRe.test(rawLines[k])) {
      k++;
    }
    const closed = k < rawLines.length;
    const rows = rawLines.slice(i + 1, closed ? k : rawLines.length).filter((line) => line.trim()).length;
    if (rows > 0) {
      kept.push(placeholderForFence(m[2].trim(), rows, closed));
    }
    i = closed ? k : rawLines.length - 1;
  }
  out = kept.join('\n');

  // 2) 链接：飞书渲染 file:// 会变成空白，只保留链接文字
  out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label: string, url: string) => {
    if (/^(?:https?|mailto):/i.test(url)) {
      return match;
    }
    const text = label.replace(/`/g, '').trim();
    return text || prettyUrl(url);
  });
  out = out.replace(/<(?:file|vscode-file):\/\/[^>\s]+>/gi, (match) => prettyUrl(match));
  out = out.replace(/(?:file|vscode-file):\/\/[^\s)\]}"'，。；]+/gi, (match) => prettyUrl(match));

  // 3) 行内代码：飞书对单反引号支持不稳定 → 去壳保留内容
  out = out.replace(/`([^`\n]+)`/g, '$1');
  out = out.replace(/`+/g, '');

  out = out.replace(/^(\s{0,3})#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, indent: string, title: string) => `${indent}**${title.trim()}**`);

  // 4) 任务列表：保留 [x]/[ ] 文字标记，不使用 emoji

  out = out.replace(/(^|\n)((?:\|.*\|\s*(?:\n|$))+)/g, (match, lead: string, block: string) => {
    const rows = block
      .trim()
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    if (rows.length < 2) {
      return match;
    }
    const cells = rows.map((row) =>
      row
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
    const isSeparator = (row: string[]) => row.every((cell) => /^:?-{2,}:?$/.test(cell));
    const header = cells[0];
    const body = cells.slice(1).filter((row) => !isSeparator(row));
    if (body.length === 0) {
      return match;
    }
    const lines = [`**${header.join(' · ')}**`, ...body.map((row) => `- ${row.join(' · ')}`)];
    return `${lead}${lines.join('\n')}\n`;
  });

  out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '────────');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  if (!options.keepEmoji) {
    out = stripEmoji(out);
  }
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 同时产出 v2（折叠面板，推荐）与 v1（降级，不支持折叠）两种卡片。
 * v2 里思考用 collapsible_panel：流式时 expanded=true，完成时 false，用户可点击展开。
 */
export function buildStreamingCards(options: StreamingCardOptions): CardPair {
  const thinking = normalizeMarkdownForFeishu(options.thinking || '');
  const answer = normalizeMarkdownForFeishu(options.answer || '');
  const tools = options.tools || [];
  const status = (options.status || '').trim();
  const showThinking = options.showThinking !== false;

  const build = (thinkingLimit: number, answerLimit: number, withThinking: boolean): CardPair => {
    const elements: object[] = [];
    if (withThinking && showThinking && thinking) {
      elements.push(buildThoughtPanel(tail(thinking, thinkingLimit), options.expanded));
    }
    if (answer) {
      elements.push({ tag: 'markdown', content: tail(answer, answerLimit) });
    }
    // 进行中的工具/状态放在正文下面：正文会不断增长，放上面会被顶出视野
    if (tools.length > 0) {
      elements.push({
        tag: 'markdown',
        content: ['**进行中**', ...tools.slice(-10).map((tool) => `- ${toolLabelForCard(tool)}`)].join('\n'),
      });
    }
    if (status) {
      elements.push({ tag: 'markdown', content: `_${status}_` });
    }
    if (options.footer) {
      elements.push({ tag: 'markdown', content: `_${options.footer}_` });
    }
    if (elements.length === 0) {
      elements.push({ tag: 'markdown', content: `_${status || '…'}_` });
    }

    const v2 = JSON.stringify({
      schema: '2.0',
      config: { width_mode: 'fill', update_multi: true },
      header: {
        title: { tag: 'plain_text', content: options.title },
        template: options.template || 'blue',
      },
      body: { elements },
    });

    const sections: string[] = [];
    if (withThinking && showThinking && thinking) {
      const quote = tail(thinking, thinkingLimit)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      sections.push(['**思考过程**', quote].join('\n'));
    }
    if (answer) {
      sections.push(tail(answer, answerLimit));
    }
    if (tools.length > 0) {
      sections.push(['**进行中**', ...tools.slice(-10).map((tool) => `- ${toolLabelForCard(tool)}`)].join('\n'));
    }
    if (status) {
      sections.push(`_${status}_`);
    }
    if (options.footer) {
      sections.push(`_${options.footer}_`);
    }
    const v1 = buildCardV1(sections.join('\n\n') || '_…_', {
      title: options.title,
      template: (options.template as any) || 'blue',
    });
    return { v2, v1 };
  };

  // 飞书卡片内容有体积上限（UTF-8 字节），超限会返回 400/500：逐级缩容
  let thinkingLimit = options.thinkingLimit ?? 4000;
  let answerLimit = options.answerLimit ?? 6000;
  let withThinking = true;
  let pair = build(thinkingLimit, answerLimit, withThinking);
  for (let guard = 0; guard < 6 && Buffer.byteLength(pair.v2, 'utf8') > 24000; guard++) {
    if (thinkingLimit > 800) {
      thinkingLimit = Math.floor(thinkingLimit * 0.6);
    } else if (answerLimit > 1500) {
      answerLimit = Math.floor(answerLimit * 0.6);
    } else if (withThinking) {
      withThinking = false;
    } else {
      break;
    }
    pair = build(thinkingLimit, answerLimit, withThinking);
  }
  return pair;
}

export function truncateForText(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…（已截断，完整内容见 VS Code）`;
}

/** 流式预览保留尾部（思考/回答都是追加式输出） */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `…（前文已省略）\n${text.slice(text.length - maxChars)}`;
}

/** 把流式内容包成带状态提示的 markdown */
export function renderStreamingMarkdown(options: {
  thinking?: string;
  answer?: string;
  tools?: string[];
  status: string;
  thinkingLimit?: number;
}): string {
  const sections: string[] = [];
  const thinking = (options.thinking || '').trim();
  if (thinking) {
    const quote = tail(thinking, options.thinkingLimit ?? 1200)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    sections.push(['**思考过程**', quote].join('\n'));
  }
  const tools = options.tools || [];
  if (tools.length > 0) {
    sections.push(['**工具调用**', ...tools.slice(-8).map((tool) => `- ${tool}`)].join('\n'));
  }
  const answer = (options.answer || '').trim();
  if (answer) {
    sections.push(tail(answer, 6000));
  }
  if (sections.length === 0) {
    return `_${options.status}_`;
  }
  sections.push(`_${options.status}_`);
  return sections.join('\n\n');
}
