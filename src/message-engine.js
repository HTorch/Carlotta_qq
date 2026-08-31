import {
  buildImageMessage as defaultBuildImageMessage,
  generateImg2 as defaultGenerateImg2,
  getImageApiTimeoutSeconds as defaultGetImageApiTimeoutSeconds,
  getImg2CacheDir as defaultGetImg2CacheDir,
  persistOutputImage as defaultPersistOutputImage,
} from './img2-service.js';

// allow: SIZE_OK — central message dispatcher with ordered command/state branches.

function extractPlainText(event) {
  if (typeof event.raw_message === 'string' && event.raw_message.trim()) {
    return event.raw_message.trim();
  }

  if (typeof event.message === 'string') {
    return event.message.trim();
  }

  if (Array.isArray(event.message)) {
    return event.message
      .filter((segment) => segment.type === 'text')
      .map((segment) => segment.data?.text ?? '')
      .join('')
      .trim();
  }

  return '';
}

function extractTransformableText(event) {
  if (typeof event.message === 'string') {
    const text = event.message.trim();
    if (text) {
      return text;
    }
  }

  if (Array.isArray(event.message)) {
    const text = event.message
      .filter((segment) => segment.type === 'text')
      .map((segment) => segment.data?.text ?? '')
      .join('')
      .trim();

    if (text) {
      return text;
    }
  }

  if (typeof event.raw_message === 'string' && !event.raw_message.includes('[CQ:')) {
    const text = event.raw_message.trim();
    if (text) {
      return text;
    }
  }

  return null;
}

const MOTHER_MODE_PHRASE_REPLACEMENTS = [
  ['爷爷', '奶奶'],
  ['爸爸', '妈妈'],
  ['父亲', '母亲'],
  ['丈夫', '妻子'],
  ['给给', '拉拉'],
  ['公公', '婆婆'],
  ['先生', '女士'],
  ['男生', '女生'],
  ['男孩', '女孩'],
  ['男人', '女人'],
  ['男士', '女士'],
  ['弟弟', '妹妹'],
  ['兄弟', '姐妹'],
  ['叔叔', '阿姨'],
  ['夫君', '娘子'],
  ['相公', '娘子'],
  ['儿子', '女儿'],
];

const MOTHER_MODE_CHAR_REPLACEMENTS = new Map([
  ['公', '母'],
  ['雄', '雌'],
  ['牡', '牝'],
  ['男', '女'],
  ['爷', '奶'],
  ['爹', '娘'],
  ['爸', '妈'],
  ['父', '母'],
  ['夫', '妻'],
  ['哥', '姐'],
]);

function transformMotherModeText(text) {
  let transformedText = String(text);

  for (const [source, target] of MOTHER_MODE_PHRASE_REPLACEMENTS) {
    transformedText = transformedText.replaceAll(source, target);
  }

  const protectedTokens = [
    ['老公', '\uE000\uE002'],
    ['老婆', '\uE000\uE003'],
  ];

  for (const [source, placeholder] of protectedTokens) {
    transformedText = transformedText.replaceAll(source, placeholder);
  }

  transformedText = transformedText.replace(/[公雄牡男爷爹爸父夫哥]/gu, (char) => MOTHER_MODE_CHAR_REPLACEMENTS.get(char) ?? char);

  for (const [source, placeholder] of protectedTokens) {
    transformedText = transformedText.replaceAll(placeholder, source);
  }

  return transformedText;
}

function hasMotherModeTransformableText(text) {
  return transformMotherModeText(text) !== String(text);
}

const IGNORE_USER_COMMAND_PATTERN = /^(un)?fuck(\d{5,12})$/u;
const PROTECTED_IGNORE_USER_IDS = new Set(['100001']);
const BOT_ADMIN_USER_ID = '100001';

function extractIgnoreCommand(atTriggeredCommand) {
  const normalizedCommand = normalizeCommandText(atTriggeredCommand);
  const ignoredUserMatch = normalizedCommand.match(IGNORE_USER_COMMAND_PATTERN);

  if (!ignoredUserMatch?.[2]) {
    return null;
  }

  return {
    action: ignoredUserMatch[1] === 'un' ? 'unignore' : 'ignore',
    userId: ignoredUserMatch[2],
  };
}

function isProtectedIgnoreTarget(userId) {
  return PROTECTED_IGNORE_USER_IDS.has(String(userId));
}

function isBotAdminUser(userId) {
  return String(userId) === BOT_ADMIN_USER_ID;
}

function getBotAvailabilityCommand(commandText) {
  switch (normalizeCommandText(commandText)) {
    case normalizeCommandText('启动'):
    case normalizeCommandText('开启'):
      return 'enable';
    case normalizeCommandText('关机'):
    case normalizeCommandText('关闭'):
      return 'disable';
    case normalizeCommandText('重启'):
      return 'restart';
    default:
      return null;
  }
}

function getYesNoReplyToggleCommand(commandText) {
  switch (normalizeCommandText(commandText)) {
    case normalizeCommandText('问句on'):
      return 'enable';
    case normalizeCommandText('问句off'):
      return 'disable';
    default:
      return null;
  }
}

const PORT_HELP_SEGMENT_DELAY_MS = 1000;

function buildHelpSections(rule) {
  const triggerCommand = `${rule.triggerPrefix}${rule.triggerSuffix}`;

  return {
    basic: [
      `• @bot ping / ${rule.triggerPrefix}ping：回复 pong`,
      '• @bot help：查看这份帮助',
      '• @bot help <触发词>：查看对应功能的详细格式与限制',
      '• 全局管理员 QQ100001 @bot 启动 / 开启 / 重启 / 关机 / 关闭：软控制 bot',
      '• 全局管理员 @bot compact：压缩当前群聊天记忆（摘要不公开）',
      '• 全局管理员 @bot new：清空当前群聊天记忆',
    ],
    chat: [
      '• @bot <普通文本>：在配置聊天模型后进入群聊模式',
      '• @bot 母on / 母off：开启 / 关闭常见性别字/词替换（如 爸妈、爷奶、给给/拉拉、丈夫/妻子 等）',
      '• @bot fuck<QQ号> / unfuck<QQ号>：将 QQ 加入 / 移出本群忽略名单（管理员除外）',
      '• @bot 球形闪电on / 球形闪电off：开启 / 关闭闪电批量倍率模式',
      '• @bot img2 <提示词>：生成图片，可附参考图',
      '• 任意群员 @bot role <临时角色> / @bot forget：设置 / 清除本群共享临时 role',
      '• @bot cron [YYYYMMDDHHmm] [every <周期> [until <时间>|never|times <次数>] [broadcast]] | <内容>：建立群提醒；cron cancel <任务ID> 取消自己的提醒',
      `• @bot say <内容> / ${rule.triggerPrefix}say <内容>：原样复述后面的内容`,
      '• @bot <数学表达式>：直接计算，如 1+2*3',
    ],
    questionAndRandom: [
      '• @bot 问句on / 问句off：开启 / 关闭问句随机应答',
      '• @bot ？？<是非问句>：开启问句随机应答后，50% 概率返回肯定 / 否定形式',
      '• @bot rnd[下限,上限]fN / rnd[下限,上限)fN / rnd(下限,上限]fN / rnd(下限,上限)fN 或对应 z：本地随机数（fN 为 f0 到 f10）',
    ],
    lightning: [
      `• 发送 ${triggerCommand} 或 @bot ${rule.triggerSuffix}：开启一道闪电监听`,
      `• 直接发送 挂N闪电、${rule.triggerPrefix}挂N闪电 或 @bot 挂N闪电：一次挂 N 道闪电，N 最大 100`,
      `• 发送 ${rule.triggerPrefix}发射天气弹 或 @bot 发射天气弹：取消当前群闪电监听`,
      '• 直接发送 劈我：在已有闪电时劈自己',
      '• 闪电监听期间，普通消息可能触发劈人；需要 bot 在群内有管理员权限',
    ],
    remote: [
      '• 仅 PORT 可用：@bot remote <群号> | 母on / 母off',
      '• 仅 PORT 可用：@bot remote <群号> | 球形闪电on / 球形闪电off',
      '• 仅 PORT 可用：@bot remote <群号> | say <内容>',
      '• 仅 PORT 且管理员 QQ100001 可用：@bot remote <群号> | prompt <内容> / prompt clear',
    ],
    automatic: '• 自动：同图 / 同文连续重复会复读',
  };
}

function buildHelpMessage(rule) {
  const sections = buildHelpSections(rule);
  return [
    '当前功能：',
    ...sections.basic,
    sections.questionAndRandom[0],
    ...sections.chat,
    ...sections.lightning,
    sections.automatic,
  ].join('\n');
}

const HELP_TOPIC_LIST = '可查询：cron、rnd、img2、role、remote、问句、挂闪电、say、ping、启动';

function getDetailedHelpMessage(topicText) {
  switch (normalizeCommandText(topicText)) {
    case 'cron':
      return 'cron：@柯莱塔 cron [YYYYMMDDHHmm] [every <周期> [until <时间>|never|times <次数>] [broadcast]] | <内容>\n省略首次时间取当前分钟；周期支持 m/h/d/w，小于 1 小时必须限制在 10 次内。默认 @创建者，broadcast 只发正文。取消：@柯莱塔 cron cancel <任务ID>（创建者或管理员）。';
    case 'rnd':
      return 'rnd：@柯莱塔 rnd[下限,上限]fN（也支持四种括号组合和 z）。f0 到 f10 输出对应小数位，z 输出整数；格式错误返回用法，空区间或超大区间会拒绝。';
    case 'img2':
      return 'img2：@柯莱塔 img2 <提示词>。可附图片或参考图链接；必须提供提示词。生成可能需要一段时间，失败会返回原因。';
    case 'role':
    case 'forget':
      return 'role：@柯莱塔 role <临时角色> 设置本群共享临时 role；@柯莱塔 forget 清除。任意群员可用；role 不写入聊天历史，new 或管理员重启会清除。';
    case 'remote':
      return 'remote：仅 PORT 群可用：@柯莱塔 remote <群号> | 母on / 母off / 球形闪电on / 球形闪电off / say <内容>。prompt 远程管理还要求管理员 QQ100001。';
    case '问句':
      return '问句：@柯莱塔 问句on / 问句off 开关本群随机应答；开启后 @柯莱塔 ？？<是非问句> 有 50% 概率给出肯定或否定回复。必须恰好两个前导 ？？。';
    case '挂闪电':
      return '挂闪电：发送 柯莱塔挂闪电 或 @柯莱塔 挂闪电 开启监听；@柯莱塔 挂N闪电 一次挂 N 道，N 最大 100；发射天气弹取消。机器人需要群管理员权限。';
    case 'say':
      return 'say：@柯莱塔 say <内容> 原样复述内容。PORT 群可用 remote <群号> | say <内容> 向目标群发送。';
    case 'ping':
      return 'ping：@柯莱塔 ping 或 柯莱塔ping，机器人回复 pong。';
    case '启动':
    case '开启':
    case '重启':
    case '关机':
    case '关闭':
      return '软控：仅管理员 QQ100001 可用 @柯莱塔 启动 / 开启 / 重启 / 关机 / 关闭。它只切换 bot 是否响应消息，不停止监听进程；重启会清除聊天记忆和临时 role。';
    default:
      return null;
  }
}

function buildPortHelpMessages(rule) {
  const sections = buildHelpSections(rule);

  return [
    [
      'PORT 帮助 1/4：基础与管理',
      ...sections.basic,
    ].join('\n'),
    [
      'PORT 帮助 2/4：聊天与群功能',
      ...sections.chat,
    ].join('\n'),
    [
      'PORT 帮助 3/4：问句、随机与闪电',
      ...sections.questionAndRandom,
      ...sections.lightning,
    ].join('\n'),
    [
      'PORT 帮助 4/4：远程与自动功能',
      ...sections.remote,
      sections.automatic,
    ].join('\n'),
  ];
}

function waitForHelpSegmentDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const PORT_TEST_GROUP_ID = '200001';
const REMOTE_USAGE = '用法：@柯莱塔 remote <群号> | <命令>';
const REMOTE_NON_PORT = '只有 PORT 测试群可以远程执行。';
const YES_NO_USAGE = '用法：@柯莱塔 ？？<是非问句>';
const CRON_USAGE = '用法：@柯莱塔 cron [YYYYMMDDHHmm] [every <周期> [until <时间>|never|times <次数>] [broadcast]] | <内容> / cron cancel <任务ID>';
const MAX_SHARED_INSTRUCTION_CHARS = 4000;

function isWithinInstructionLimit(value) {
  return Array.from(String(value ?? '')).length <= MAX_SHARED_INSTRUCTION_CHARS;
}

function isPortTestGroup(groupId) {
  return String(groupId) === PORT_TEST_GROUP_ID;
}

function classifyRemoteCommand(atTriggeredCommand) {
  const rawCommand = String(atTriggeredCommand ?? '').trim();
  if (!rawCommand) {
    return { kind: 'none', commandText: rawCommand, targetGroupId: null };
  }

  if (rawCommand.startsWith('remote')) {
    const match = rawCommand.match(/^remote[ ]+(\d{5,12})[ ]*\|([\s\S]*)$/u);
    if (!match) {
      return { kind: 'invalid' };
    }

    const commandText = match[2].trim();
    if (!commandText) {
      return { kind: 'invalid' };
    }

    const isToggle = ['母on', '母off', '球形闪电on', '球形闪电off'].includes(commandText);
    const sayMatch = commandText.match(/^say(?:[ \t]+([\s\S]*))?$/u);
    const promptMatch = commandText.match(/^prompt(?:[ \t]+([\s\S]*))?$/u);
    const isPrompt = Boolean(promptMatch);
    if (!isToggle && (!sayMatch || !sayMatch[1]?.trim()) && !isPrompt) {
      return { kind: 'invalid' };
    }

    return {
      kind: 'valid',
      commandText,
      targetGroupId: match[1],
    };
  }

  if (/^(?:母(?:on|off)|球形闪电(?:on|off))[ \t]+(?:\d{5,12}|\{\d{5,12}\})$/u.test(rawCommand)
    || /^say[^\n]*\{\d{5,12}\}$/u.test(rawCommand)) {
    return { kind: 'invalid' };
  }

  return { kind: 'none', commandText: rawCommand, targetGroupId: null };
}

function parsePromptRemoteCommand(commandText) {
  const match = String(commandText ?? '').match(/^prompt(?:[ \t]+([\s\S]*))?$/u);
  if (!match) {
    return null;
  }

  const content = String(match[1] ?? '').trim();
  if (!content) {
    return { action: 'invalid', prompt: null };
  }

  if (content === 'clear') {
    return { action: 'clear', prompt: null };
  }

  return { action: 'set', prompt: content };
}

function parseSharedRoleCommand(commandText) {
  const normalized = String(commandText ?? '').trim();
  if (normalized === 'forget') {
    return { action: 'clear', role: null };
  }

  if (!normalized.startsWith('role')) {
    return null;
  }

  const role = normalized.slice('role'.length).trim();
  return { action: role ? 'set' : 'invalid', role: role || null };
}

function parseCronCommand(commandText) {
  const match = String(commandText ?? '').trim().match(/^cron(?:[ \t]+([\s\S]*))?$/u);
  if (!match) {
    return null;
  }

  const body = String(match[1] ?? '').trim();
  const cancelMatch = body.match(/^cancel(?:[ \t]+(\S+))$/u);
  if (cancelMatch) {
    return { kind: 'cancel', taskId: cancelMatch[1] };
  }

  if (!body || body === 'cancel' || body.startsWith('cancel ')) {
    return { kind: 'invalid' };
  }

  return { kind: 'create', commandText: body };
}

export function createSharedRoleStore() {
  const roles = new Map();
  return {
    get(groupId) {
      return roles.get(String(groupId)) ?? null;
    },
    set(groupId, role) {
      roles.set(String(groupId), role);
    },
    clear(groupId) {
      roles.delete(String(groupId));
    },
    clearAll() {
      roles.clear();
    },
  };
}

function isSensitiveCommand(atTriggeredCommand) {
  const command = String(atTriggeredCommand ?? '').trim();
  return /^remote[ \t]+\d{5,12}[ \t]*\|[\s\S]*\bprompt(?:[ \t]|$)/u.test(command)
    || /^role(?:[ \t]|\S)/u.test(command)
    || /^cron(?:[ \t]|$)/u.test(command);
}

function normalizeCommandText(text) {
  return String(text)
    .replace(/\s+/g, '')
    .trim();
}

function normalizeRepeatText(text) {
  return String(text).trim();
}

const REPEAT_IGNORED_SEGMENT_TYPES = new Set(['reply', 'at']);

function normalizeRepeatSegment(segment) {
  if (!segment || typeof segment.type !== 'string' || REPEAT_IGNORED_SEGMENT_TYPES.has(segment.type)) {
    return null;
  }

  const data = segment.data ?? {};

  if (segment.type === 'text') {
    const text = normalizeRepeatText(data.text ?? '');
    if (!text) {
      return null;
    }

    return {
      signaturePart: `text:${text}`,
      payloadSegment: { type: 'text', data: { text } },
    };
  }

  if (segment.type === 'image' || segment.type === 'video' || segment.type === 'record' || segment.type === 'file') {
    const value = normalizeRepeatText(data.file ?? data.url ?? data.path ?? data.md5 ?? '');
    if (!value) {
      return null;
    }

    return {
      signaturePart: `${segment.type}:${value}`,
      payloadSegment: { type: segment.type, data: { ...data } },
    };
  }

  if (segment.type === 'face') {
    const value = normalizeRepeatText(data.id ?? '');
    if (!value) {
      return null;
    }

    return {
      signaturePart: `face:${value}`,
      payloadSegment: { type: 'face', data: { ...data } },
    };
  }

  if (segment.type === 'mface') {
    const value = normalizeRepeatText(data.emojiId ?? data.id ?? data.md5Hex ?? data.file ?? data.url ?? '');
    if (!value) {
      return null;
    }

    return {
      signaturePart: `mface:${value}`,
      payloadSegment: { type: 'mface', data: { ...data } },
    };
  }

  return null;
}

function buildRepeatPlan(event, messageText) {
  if (Array.isArray(event.message)) {
    const normalizedSegments = event.message
      .map((segment) => normalizeRepeatSegment(segment))
      .filter(Boolean);

    if (normalizedSegments.length === 0) {
      return null;
    }

    if (normalizedSegments.every((segment) => segment.payloadSegment.type === 'text')) {
      const text = normalizedSegments.map((segment) => segment.payloadSegment.data.text).join('').trim();
      return text ? { signature: `text:${text}`, payload: text } : null;
    }

    return {
      signature: `segments:${normalizedSegments.map((segment) => segment.signaturePart).join('|')}`,
      payload: normalizedSegments.map((segment) => segment.payloadSegment),
    };
  }

  const text = normalizeRepeatText(messageText);
  return text ? { signature: `text:${text}`, payload: text } : null;
}

function isArithmeticExpression(text) {
  const normalized = String(text).trim();
  if (!normalized) {
    return false;
  }

  if (/^(null|undefined|nan|infinity)$/i.test(normalized)) {
    return false;
  }

  return /^[\d+\-*/^().\s]+$/.test(normalized);
}

function tokenizeExpression(expression) {
  const tokens = [];
  let index = 0;
  const source = expression.replace(/\s+/g, '');

  while (index < source.length) {
    const char = source[index];

    if (/\d|\./.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\d.]/.test(source[end])) {
        end += 1;
      }

      const numberToken = source.slice(index, end);
      if (!/^\d+(\.\d+)?$|^\.\d+$/.test(numberToken)) {
        throw new Error('Invalid number');
      }

      tokens.push(numberToken);
      index = end;
      continue;
    }

    if ('+-*/^()'.includes(char)) {
      const previousToken = tokens[tokens.length - 1] ?? null;
      const isUnaryMinus = char === '-' && (previousToken === null || '+-*/^('.includes(previousToken));
      if (isUnaryMinus) {
        tokens.push('0');
      }

      tokens.push(char);
      index += 1;
      continue;
    }

    throw new Error('Invalid token');
  }

  return tokens;
}

function toReversePolishNotation(tokens) {
  const output = [];
  const operators = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
  const rightAssociative = new Set(['^']);

  for (const token of tokens) {
    if (!Number.isNaN(Number(token))) {
      output.push(token);
      continue;
    }

    if ('+-*/^'.includes(token)) {
      while (operators.length > 0) {
        const top = operators[operators.length - 1];
        if (!'+-*/^'.includes(top)) {
          break;
        }

        const shouldPop = rightAssociative.has(token)
          ? precedence[top] > precedence[token]
          : precedence[top] >= precedence[token];

        if (!shouldPop) {
          break;
        }

        output.push(operators.pop());
      }

      operators.push(token);
      continue;
    }

    if (token === '(') {
      operators.push(token);
      continue;
    }

    if (token === ')') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') {
        output.push(operators.pop());
      }

      if (operators.pop() !== '(') {
        throw new Error('Mismatched parentheses');
      }
    }
  }

  while (operators.length > 0) {
    const top = operators.pop();
    if (top === '(' || top === ')') {
      throw new Error('Mismatched parentheses');
    }

    output.push(top);
  }

  return output;
}

function evaluateArithmeticExpression(expression) {
  if (expression == null) {
    throw new Error('Empty expression');
  }

  const normalizedExpression = String(expression).trim();
  if (!normalizedExpression || /^(null|undefined|nan|infinity)$/i.test(normalizedExpression)) {
    throw new Error('Invalid expression');
  }

  const rpn = toReversePolishNotation(tokenizeExpression(expression));
  const stack = [];

  for (const token of rpn) {
    if (!Number.isNaN(Number(token))) {
      stack.push(Number(token));
      continue;
    }

    const right = stack.pop();
    const left = stack.pop();
    if (left === undefined || right === undefined) {
      throw new Error('Invalid expression');
    }

    switch (token) {
      case '+':
        stack.push(left + right);
        break;
      case '-':
        stack.push(left - right);
        break;
      case '*':
        stack.push(left * right);
        break;
      case '/':
        if (right === 0) {
          throw new Error('Division by zero');
        }
        stack.push(left / right);
        break;
      case '^':
        stack.push(left ** right);
        break;
      default:
        throw new Error('Invalid operator');
    }
  }

  if (stack.length !== 1) {
    throw new Error('Invalid expression');
  }

  const result = stack[0];
  if (!Number.isFinite(result)) {
    throw new Error('Numeric overflow');
  }

  if (Math.abs(result) > 1e12) {
    throw new Error('Result too large');
  }

  return Number.isInteger(result) ? String(result) : String(Number(result.toFixed(10)));
}

const RND_USAGE = '用法：@柯莱塔 rnd[下限,上限]fN / rnd[下限,上限)fN / rnd(下限,上限]fN / rnd(下限,上限)fN 或对应 z（fN 为 f0 到 f10）';
const RND_INVALID_RANGE = '随机区间无效：请检查边界、范围或格式';
const RND_DECIMAL_PATTERN = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const RND_COMMAND_PATTERN = new RegExp(`^rnd([\\[(])\\s*(${RND_DECIMAL_PATTERN})\\s*,\\s*(${RND_DECIMAL_PATTERN})\\s*([\\])])(f(?:10|[0-9])|z)$`, 'u');
const RND_SIGNED_INT32_MIN = -2_147_483_648n;
const RND_SIGNED_INT32_MAX = 2_147_483_647n;
const RND_RANDOM_INTEGER_SCALE = 1n << 53n;

function parseDecimalRational(value) {
  const text = String(value);
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/u, '');
  const [wholePart, fractionalPart = ''] = unsigned.split('.');
  const digits = `${wholePart}${fractionalPart}`;
  const numerator = BigInt(digits) * (negative ? -1n : 1n);
  const denominator = 10n ** BigInt(fractionalPart.length);

  return { numerator, denominator };
}

function floorRational(numerator, denominator) {
  if (numerator >= 0n) {
    return numerator / denominator;
  }

  return -((-numerator + denominator - 1n) / denominator);
}

function ceilRational(numerator, denominator) {
  return -floorRational(-numerator, denominator);
}

function isRationalWithinSignedInt32({ numerator, denominator }) {
  return numerator >= RND_SIGNED_INT32_MIN * denominator
    && numerator <= RND_SIGNED_INT32_MAX * denominator;
}

function parseRndCommand(commandText) {
  const match = String(commandText ?? '').match(RND_COMMAND_PATTERN);
  if (!match) {
    return null;
  }

  return {
    lowerInclusive: match[1] === '[',
    lower: parseDecimalRational(match[2]),
    upper: parseDecimalRational(match[3]),
    upperInclusive: match[4] === ']',
    format: match[5],
  };
}

function getRndCandidateBounds(parsed) {
  if (!isRationalWithinSignedInt32(parsed.lower) || !isRationalWithinSignedInt32(parsed.upper)) {
    return null;
  }

  const scale = parsed.format === 'z' ? 1n : 10n ** BigInt(parsed.format.slice(1));
  const lowerScaledNumerator = parsed.lower.numerator * scale;
  const upperScaledNumerator = parsed.upper.numerator * scale;
  const lower = parsed.lowerInclusive
    ? ceilRational(lowerScaledNumerator, parsed.lower.denominator)
    : floorRational(lowerScaledNumerator, parsed.lower.denominator) + 1n;
  const upper = parsed.upperInclusive
    ? floorRational(upperScaledNumerator, parsed.upper.denominator)
    : ceilRational(upperScaledNumerator, parsed.upper.denominator) - 1n;

  if (upper < lower) {
    return null;
  }

  return { lower, upper };
}

function selectRndCandidate(lower, upper, random) {
  const count = upper - lower + 1n;
  const roll = Number(random());
  const normalizedRoll = Number.isFinite(roll) ? Math.max(0, Math.min(1, roll)) : 0;
  if (normalizedRoll >= 1) {
    return upper;
  }

  const randomNumerator = BigInt(Math.floor(normalizedRoll * Number(RND_RANDOM_INTEGER_SCALE)));
  const offset = randomNumerator * count / RND_RANDOM_INTEGER_SCALE;
  return lower + offset;
}

function formatRndCandidate(candidate, format) {
  if (format === 'z') {
    return candidate.toString();
  }

  const places = Number(format.slice(1));
  if (places === 0) {
    return candidate.toString();
  }

  const negative = candidate < 0n;
  const absolute = (negative ? -candidate : candidate).toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${absolute.slice(0, -places)}.${absolute.slice(-places)}`;
}

function resolveRndCommand(commandText, random) {
  const parsed = parseRndCommand(commandText);
  if (!parsed) {
    return { kind: 'usage' };
  }

  const candidateBounds = getRndCandidateBounds(parsed);
  if (!candidateBounds) {
    return { kind: 'invalid-range' };
  }

  return {
    kind: 'value',
    value: formatRndCandidate(
      selectRndCandidate(candidateBounds.lower, candidateBounds.upper, random),
      parsed.format,
    ),
  };
}

function formatLightningTriggerReply(baseReply, armedCount) {
  return `${baseReply}（现在有${armedCount}道闪电）`;
}

function parseLightningIncrement(rawCommand, triggerSuffix) {
  const normalizedCommand = normalizeCommandText(rawCommand ?? '');
  const normalizedSuffix = normalizeCommandText(triggerSuffix);

  if (normalizedCommand === normalizedSuffix) {
    return 1;
  }

  const match = normalizedCommand.match(/^挂(\d+)([\u4e00-\u9fff]{0,3})?闪电$/);
  if (!match) {
    return null;
  }

  const count = Number(match[1]);
  if (!Number.isInteger(count) || count <= 0) {
    return null;
  }

  return Math.min(count, 100);
}

function formatLightningSuccessReply(baseReply, remainingCount) {
  if (remainingCount > 0) {
    return `${baseReply}（还剩${remainingCount}道闪电）`;
  }

  return `${baseReply}（闪电已经用完了）`;
}

function calculateSphereLightningMultiplier(remainingCount, random) {
  const numericRemaining = Math.max(0, Math.floor(Number(remainingCount) || 0));
  if (numericRemaining <= 0) {
    return 1;
  }

  const upperBound = numericRemaining < 5 ? numericRemaining : Math.floor(numericRemaining / 5);
  const safeUpperBound = Math.max(1, upperBound);
  const roll = Math.floor(random() * safeUpperBound) + 1;
  return Math.max(1, Math.min(safeUpperBound, roll));
}

function formatSphereLightningBurstReply(multiplier) {
  const repeatCount = Math.max(1, Math.floor(Number(multiplier) || 1));
  return `${'⚡'.repeat(repeatCount)}${'！'.repeat(repeatCount)}`;
}

function isLikelySendTimeout(error) {
  return /OneBot API timeout for action send_group_msg/i.test(String(error?.message ?? error ?? ''));
}

function extractAtTriggeredCommand(event) {
  const selfId = String(event.self_id ?? '');

  if (Array.isArray(event.message) && selfId) {
    const segments = event.message;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];

      if (segment.type === 'reply') {
        continue;
      }

      if (segment.type === 'text' && (segment.data?.text ?? '').trim() === '') {
        continue;
      }

      if (segment.type !== 'at') {
        break;
      }

      if (String(segment.data?.qq ?? '') !== selfId) {
        return null;
      }

      return segments
        .slice(index + 1)
        .map((nextSegment) => (nextSegment.type === 'text' ? (nextSegment.data?.text ?? '') : ''))
        .join('')
        .trim();
    }
  }

  const rawMessage = typeof event.raw_message === 'string' ? event.raw_message : '';
  if (selfId && rawMessage.includes(`[CQ:at,qq=${selfId}]`)) {
    return rawMessage.replace(/\[CQ:reply,[^\]]+\]/g, '').replace(/\[CQ:at,qq=\d+\]/g, '').trim();
  }

  const plainText = extractPlainText(event);
  const plainMentionMatch = plainText.match(/^@(柯莱塔|珂莱塔)\s+(.+)$/);
  if (plainMentionMatch) {
    return plainMentionMatch[2].trim();
  }

  const plainMentionTailMatch = plainText.match(/^@(柯莱塔|珂莱塔)(?:\s*(.*))?$/);
  if (plainMentionTailMatch) {
    return (plainMentionTailMatch[2] ?? '').trim();
  }

  return null;
}

function buildYesNoReplyPlan(atTriggeredCommand) {
  const candidate = String(atTriggeredCommand ?? '').trim();
  if (!candidate) {
    return null;
  }

  const body = candidate.replace(/[?？]+$/u, '').trim();
  if (!body) {
    return null;
  }

  const normalizedBody = body.replace(/[吗嘛么]+$/u, '').trim();
  const targetBody = normalizedBody || body;

  const markMatches = [
    '是不是',
    '是否',
    '有没有',
    '有没有',
    '能不能',
    '可不可以',
    '要不要',
    '会不会',
    '需不需要',
    '该不该',
    '行不行',
    '好不好',
    '对不对',
  ];

  for (const mark of markMatches) {
    if (targetBody.startsWith(mark)) {
      const remainder = targetBody.slice(mark.length).trim();
      if (!remainder) {
        return null;
      }

      return {
        positiveReply: remainder,
        negativeReply: negateYesNoReplyBody(remainder),
      };
    }
  }

  const aNotAMatch = targetBody.match(/^(?<prefix>.*?)(?<word>[\p{Script=Han}]{1,4})不\k<word>(?<suffix>.*)$/u);
  if (aNotAMatch?.groups) {
    const prefix = aNotAMatch.groups.prefix ?? '';
    const word = aNotAMatch.groups.word ?? '';
    const suffix = aNotAMatch.groups.suffix ?? '';

    const positiveReply = `${prefix}${word}${suffix}`.trim();
    const negativeReply = `${prefix}不${word}${suffix}`.trim();

    if (positiveReply && negativeReply) {
      return {
        positiveReply,
        negativeReply,
      };
    }
  }

  const aMeiAMatch = targetBody.match(/^(?<prefix>.*?)(?<word>[\p{Script=Han}]{1,4})没\k<word>(?<suffix>.*)$/u);
  if (aMeiAMatch?.groups) {
    const prefix = aMeiAMatch.groups.prefix ?? '';
    const word = aMeiAMatch.groups.word ?? '';
    const suffix = aMeiAMatch.groups.suffix ?? '';

    const positiveReply = `${prefix}${word}${suffix}`.trim();
    const negativeReply = `${prefix}没${word}${suffix}`.trim();

    if (positiveReply && negativeReply) {
      return {
        positiveReply,
        negativeReply,
      };
    }
  }

  return null;
}

function getExactYesNoPrefixBody(atTriggeredCommand) {
  const candidate = String(atTriggeredCommand ?? '').trim();
  if (!candidate.startsWith('？？') || candidate.startsWith('？？？')) {
    return null;
  }

  return candidate.slice(2).trim();
}

function negateYesNoReplyBody(body) {
  const text = String(body ?? '').trim();
  if (!text) {
    return '';
  }

  const replacements = [
    [/^是/, '不是'],
    [/^有/, '没有'],
    [/^会/, '不会'],
    [/^能/, '不能'],
    [/^可(?:以)?/, '不可以'],
    [/^要/, '不要'],
    [/^需(?:要)?/, '不需要'],
    [/^该/, '不该'],
    [/^行/, '不行'],
    [/^好/, '不好'],
    [/^对/, '不对'],
    [/^在/, '不在'],
    [/^想/, '不想'],
    [/^喜欢/, '不喜欢'],
    [/^愿意/, '不愿意'],
    [/^活着/, '不活着'],
  ];

  for (const [pattern, replacement] of replacements) {
    if (pattern.test(text)) {
      return text.replace(pattern, replacement);
    }
  }

  const leadingParts = splitLeadingParts(text);
  if (leadingParts.rest) {
    if (shouldPreferMeiNegation(leadingParts.rest)) {
      return buildMeiNegation(leadingParts.lead, leadingParts.rest);
    }

    return `${leadingParts.lead}不${leadingParts.rest}`.trim();
  }

  return `不${text}`;
}

function shouldPreferMeiNegation(rest) {
  return [
    '有',
    '活着',
    '来',
    '去',
    '到',
    '见',
    '懂',
    '完成',
    '登录',
    '到达',
    '出现',
    '存在',
    '拥有',
  ].some((prefix) => String(rest ?? '').startsWith(prefix));
}

function buildMeiNegation(lead, rest) {
  const normalizedLead = String(lead ?? '').trim();
  const normalizedRest = String(rest ?? '').trim();

  if (!normalizedRest) {
    return normalizedLead ? `${normalizedLead}没` : '没';
  }

  if (normalizedRest.startsWith('有')) {
    return `${normalizedLead}没有${normalizedRest.slice(1)}`.trim();
  }

  return `${normalizedLead}没${normalizedRest}`.trim();
}

function splitLeadingParts(text) {
  const subjectPatterns = [
    '咱们',
    '我们',
    '你们',
    '他们',
    '她们',
    '它们',
    '大家',
    '你',
    '我',
    '他',
    '她',
    '它',
  ];

  const modifierPatterns = [
    '今天',
    '明天',
    '后天',
    '昨天',
    '现在',
    '今晚',
    '今晚',
    '早上',
    '上午',
    '中午',
    '下午',
    '晚上',
    '目前',
    '最近',
    '刚才',
    '刚刚',
    '还',
    '也',
    '就',
    '再',
    '仍然',
    '仍旧',
    '一直',
    '正在',
    '正',
    '已经',
    '可能',
    '大概',
    '也许',
    '暂时',
    '本来',
    '通常',
    '一般',
  ];

  let lead = '';
  let rest = String(text ?? '').trim();

  for (const subject of subjectPatterns) {
    if (rest.startsWith(subject)) {
      lead += subject;
      rest = rest.slice(subject.length);
      break;
    }
  }

  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const modifier of modifierPatterns) {
      if (rest.startsWith(modifier)) {
        lead += modifier;
        rest = rest.slice(modifier.length);
        advanced = true;
        break;
      }
    }
  }

  return { lead, rest };
}

function extractImageUrls(event) {
  if (!Array.isArray(event.message)) {
    return [];
  }

  return event.message
    .filter((segment) => segment.type === 'image')
    .map((segment) => segment.data?.url ?? segment.data?.file ?? '')
    .filter(Boolean);
}

function extractReferenceImageUrlsFromText(text) {
  const matches = String(text ?? '').match(/https?:\/\/\S+/g) ?? [];
  return matches.map((url) => url.trim());
}

function removeReferenceImageUrlsFromText(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractStrikeMentionTarget(event) {
  if (!Array.isArray(event.message)) {
    return null;
  }

  const meaningfulSegments = event.message.filter((segment) => {
    if (segment.type !== 'text') {
      return true;
    }

    return (segment.data?.text ?? '').trim() !== '';
  });

  if (meaningfulSegments.length < 2) {
    return null;
  }

  const firstSegment = meaningfulSegments[0];
  const strikePrefix = firstSegment.type === 'text' ? String(firstSegment.data?.text ?? '').trim() : '';
  if (!strikePrefix.startsWith('劈')) {
    return null;
  }

  const atSegment = meaningfulSegments.find((segment, index) => index > 0 && segment.type === 'at');
  if (!atSegment) {
    return null;
  }

  return String(atSegment.data?.qq ?? '') || null;
}

export class MessageEngine {
  constructor({
    apiClient,
    ruleRegistry,
    stateStore,
    actionRegistry,
    logger,
    random = Math.random,
    dependencyOverrides = {},
  }) {
    this.apiClient = apiClient;
    this.ruleRegistry = ruleRegistry;
    this.stateStore = stateStore;
    this.actionRegistry = actionRegistry;
    this.logger = logger;
    this.random = random;
    this.ignoredUserRegistry = dependencyOverrides.ignoredUserRegistry ?? null;
    this.runtimeControl = dependencyOverrides.runtimeControl ?? {
      isEnabled: () => true,
      enable() {},
      disable() {},
    };
    this.chatService = dependencyOverrides.chatService ?? null;
    this.promptRegistry = dependencyOverrides.promptRegistry ?? null;
    this.roleStore = dependencyOverrides.roleStore ?? createSharedRoleStore();
    this.cronScheduler = dependencyOverrides.cronScheduler ?? null;
    this.helpSegmentDelay = dependencyOverrides.helpSegmentDelay ?? waitForHelpSegmentDelay;
    this.img2Service = dependencyOverrides.img2Service ?? {
      buildImageMessage: defaultBuildImageMessage,
      generateImg2: defaultGenerateImg2,
      getImageApiTimeoutSeconds: defaultGetImageApiTimeoutSeconds,
      getImg2CacheDir: defaultGetImg2CacheDir,
      persistOutputImage: defaultPersistOutputImage,
    };
  }

  getGroupPrompt(groupId) {
    if (!this.promptRegistry) {
      return null;
    }

    if (typeof this.promptRegistry.getPrompt === 'function') {
      return this.promptRegistry.getPrompt(groupId);
    }

    return this.promptRegistry.get?.(groupId) ?? null;
  }

  getSharedRole(groupId) {
    if (typeof this.roleStore.getRole === 'function') {
      return this.roleStore.getRole(groupId);
    }

    return this.roleStore.get?.(groupId) ?? null;
  }

  async getBotGroupRole(groupId, selfId) {
    try {
      const response = await this.apiClient.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(selfId),
        no_cache: true,
      });

      return response.data?.role ?? null;
    } catch (error) {
      this.logger.error(`Failed to fetch bot role for group ${groupId}:`, error.message);
      return null;
    }
  }

  async handleGroupMessage(event) {
    const groupId = String(event.group_id);
    const userId = String(event.user_id);
    const rule = this.ruleRegistry.get(groupId);

    if (!rule) {
      return;
    }

    if (String(event.self_id ?? '') && userId === String(event.self_id)) {
      return;
    }

    const messageText = extractPlainText(event);
    const atTriggeredCommand = extractAtTriggeredCommand(event);
    this.logger.info('Incoming group event:', JSON.stringify({
      group_id: event.group_id,
      user_id: event.user_id,
      self_id: event.self_id,
      raw_message: isSensitiveCommand(atTriggeredCommand) ? '[REDACTED]' : event.raw_message,
      message: isSensitiveCommand(atTriggeredCommand) ? '[REDACTED]' : event.message,
    }));
    const remoteCommand = classifyRemoteCommand(atTriggeredCommand);
    if (remoteCommand.kind === 'invalid') {
      await this.apiClient.sendGroupMessage(groupId, REMOTE_USAGE);
      return;
    }

    if (remoteCommand.kind === 'valid' && !isPortTestGroup(groupId)) {
      await this.apiClient.sendGroupMessage(groupId, REMOTE_NON_PORT);
      return;
    }

    const isIgnored = this.ignoredUserRegistry
      ? this.ignoredUserRegistry.has(userId)
      : this.stateStore.isUserIgnored(groupId, userId);
    if (isIgnored && !isProtectedIgnoreTarget(userId)) {
      return;
    }

    const triggerCommand = `${rule.triggerPrefix}${rule.triggerSuffix}`;
    const cancelLightningCommand = `${rule.triggerPrefix}发射天气弹`;
    const pingCommand = `${rule.triggerPrefix}ping`;
    const sayCommandPrefix = `${rule.triggerPrefix}say`;
    const img2CommandPrefix = 'img2';
    const repeatPlan = atTriggeredCommand === null ? buildRepeatPlan(event, messageText) : null;

    if (atTriggeredCommand === null && !repeatPlan) {
      this.stateStore.clearRepeatState(groupId);
    }

    const lightningIncrement = parseLightningIncrement(atTriggeredCommand ?? messageText, rule.triggerSuffix);
    const forceLightningCommand = '劈我';
    const strikeMentionTarget = extractStrikeMentionTarget(event);
    const atTriggeredCommandText = remoteCommand.kind === 'valid'
      ? remoteCommand.commandText
      : String(atTriggeredCommand ?? '').trim();
    const remoteTargetGroupId = remoteCommand.kind === 'valid' ? remoteCommand.targetGroupId : null;
    const normalizedAtTriggeredCommand = normalizeCommandText(atTriggeredCommandText);
    const exactYesNoPrefixBody = getExactYesNoPrefixBody(atTriggeredCommand);
    const yesNoReplyPlan = this.stateStore.isYesNoReplyEnabled(groupId) && exactYesNoPrefixBody
      ? buildYesNoReplyPlan(exactYesNoPrefixBody)
      : null;
    const botAvailabilityCommand = getBotAvailabilityCommand(normalizedAtTriggeredCommand);
    const questionToggleCommand = getYesNoReplyToggleCommand(normalizedAtTriggeredCommand);
    const botIsAdmin = isBotAdminUser(userId);
    const botIsEnabled = this.runtimeControl.isEnabled();

    if (!botIsEnabled) {
      if (botAvailabilityCommand && botIsAdmin) {
        if (botAvailabilityCommand === 'enable' || botAvailabilityCommand === 'restart') {
          this.runtimeControl.enable();
          if (botAvailabilityCommand === 'restart') {
            this.chatService?.clearAllTranscripts();
            this.roleStore.clearAll();
          }
          await this.apiClient.sendGroupMessage(groupId, botAvailabilityCommand === 'restart' ? 'Bot 已重启' : 'Bot 已开启');
        } else {
          this.runtimeControl.disable();
          await this.apiClient.sendGroupMessage(groupId, 'Bot 已关机');
        }
      }

      return;
    }

    if (exactYesNoPrefixBody === '') {
      await this.apiClient.sendGroupMessage(groupId, YES_NO_USAGE);
      return;
    }

    if (botAvailabilityCommand && botIsAdmin) {
      if (botAvailabilityCommand === 'enable' || botAvailabilityCommand === 'restart') {
        this.runtimeControl.enable();
        if (botAvailabilityCommand === 'restart') {
          this.chatService?.clearAllTranscripts();
          this.roleStore.clearAll();
        }
        await this.apiClient.sendGroupMessage(groupId, botAvailabilityCommand === 'restart' ? 'Bot 已重启' : 'Bot 已开启');
      } else {
        this.runtimeControl.disable();
        await this.apiClient.sendGroupMessage(groupId, 'Bot 已关机');
      }

      return;
    }

    const cronCommand = parseCronCommand(atTriggeredCommand);
    if (cronCommand) {
      if (!this.cronScheduler) {
        await this.apiClient.sendGroupMessage(groupId, 'cron 功能尚未接入');
        return;
      }

      if (cronCommand.kind === 'invalid') {
        await this.apiClient.sendGroupMessage(groupId, CRON_USAGE);
        return;
      }

      try {
        const result = cronCommand.kind === 'create'
          ? await this.cronScheduler.create({ groupId, creatorUserId: userId, commandText: cronCommand.commandText })
          : await this.cronScheduler.cancel({ groupId, requesterUserId: userId, taskId: cronCommand.taskId });

        switch (result.kind) {
          case 'created':
            await this.apiClient.sendGroupMessage(groupId, `已建立提醒 ${result.id}，将于北京时间 ${result.firstRunText} 提醒`);
            return;
          case 'cancelled':
            await this.apiClient.sendGroupMessage(groupId, `已取消提醒 ${result.id}`);
            return;
          case 'rejected':
            await this.apiClient.sendGroupMessage(groupId, result.message);
            return;
          default:
            await this.apiClient.sendGroupMessage(groupId, 'cron 操作失败，请稍后重试');
            return;
        }
      } catch (error) {
        this.logger.error(`Cron operation failed for group ${groupId}:`, error?.message ?? error);
        await this.apiClient.sendGroupMessage(groupId, 'cron 保存失败，请稍后重试');
        return;
      }
    }

    const helpMatch = atTriggeredCommandText.match(/^help(?:[ \t]+([\s\S]*))?$/u);
    if (helpMatch) {
      const topicText = String(helpMatch[1] ?? '').trim();
      if (topicText) {
        await this.apiClient.sendGroupMessage(groupId, getDetailedHelpMessage(topicText) ?? HELP_TOPIC_LIST);
        return;
      }

      if (!isPortTestGroup(groupId)) {
        await this.apiClient.sendGroupMessage(groupId, buildHelpMessage(rule));
        return;
      }

      const helpMessages = buildPortHelpMessages(rule);
      for (let index = 0; index < helpMessages.length; index += 1) {
        await this.apiClient.sendGroupMessage(groupId, helpMessages[index]);
        if (index < helpMessages.length - 1) {
          await this.helpSegmentDelay(PORT_HELP_SEGMENT_DELAY_MS);
        }
      }
      return;
    }

    const promptRemoteCommand = remoteCommand.kind === 'valid'
      ? parsePromptRemoteCommand(remoteCommand.commandText)
      : null;
    if (promptRemoteCommand) {
      if (!botIsAdmin) {
        await this.apiClient.sendGroupMessage(groupId, '只有全局管理员可以管理群 prompt');
        return;
      }

      if (!this.promptRegistry) {
        await this.apiClient.sendGroupMessage(groupId, '群 prompt 功能尚未接入');
        return;
      }

      if (promptRemoteCommand.action === 'invalid') {
        await this.apiClient.sendGroupMessage(groupId, REMOTE_USAGE);
        return;
      }

      if (promptRemoteCommand.action === 'set' && !isWithinInstructionLimit(promptRemoteCommand.prompt)) {
        await this.apiClient.sendGroupMessage(groupId, '群 prompt 过长，最多 4000 个字符');
        return;
      }

      if (promptRemoteCommand.action === 'clear') {
        try {
          await this.promptRegistry.clear(remoteCommand.targetGroupId);
        } catch (error) {
          this.logger.error(`Group prompt clear failed for ${remoteCommand.targetGroupId}:`, error?.stack ?? error?.message ?? error);
          await this.apiClient.sendGroupMessage(groupId, '群 prompt 保存失败，请稍后重试');
          return;
        }
        await this.apiClient.sendGroupMessage(groupId, `已清除 ${remoteCommand.targetGroupId} 的群 prompt`);
        return;
      }

      try {
        await this.promptRegistry.set(remoteCommand.targetGroupId, promptRemoteCommand.prompt);
      } catch (error) {
        this.logger.error(`Group prompt set failed for ${remoteCommand.targetGroupId}:`, error?.stack ?? error?.message ?? error);
        await this.apiClient.sendGroupMessage(groupId, '群 prompt 保存失败，请稍后重试');
        return;
      }
      await this.apiClient.sendGroupMessage(groupId, `已更新 ${remoteCommand.targetGroupId} 的群 prompt`);
      return;
    }

    const sharedRoleCommand = parseSharedRoleCommand(atTriggeredCommand);
    if (sharedRoleCommand) {
      if (sharedRoleCommand.action === 'invalid') {
        await this.apiClient.sendGroupMessage(groupId, '用法：@柯莱塔 role <临时角色> / forget');
        return;
      }

      if (sharedRoleCommand.action === 'clear') {
        this.roleStore.clear(groupId);
        await this.apiClient.sendGroupMessage(groupId, '本群临时 role 已清除');
        return;
      }

      if (!isWithinInstructionLimit(sharedRoleCommand.role)) {
        await this.apiClient.sendGroupMessage(groupId, '临时 role 过长，最多 4000 个字符');
        return;
      }

      this.roleStore.set(groupId, sharedRoleCommand.role);
      await this.apiClient.sendGroupMessage(groupId, '本群临时 role 已设置');
      return;
    }

    const ignoreCommand = extractIgnoreCommand(atTriggeredCommand);
    if (ignoreCommand) {
      if (ignoreCommand.action === 'ignore' && isProtectedIgnoreTarget(ignoreCommand.userId)) {
        await this.apiClient.sendGroupMessage(groupId, `QQ${ignoreCommand.userId} 是管理员，不能无视`);
        return;
      }

      try {
        if (ignoreCommand.action === 'ignore') {
          if (this.ignoredUserRegistry) {
            await this.ignoredUserRegistry.add(ignoreCommand.userId);
          } else {
            this.stateStore.ignoreUser(groupId, ignoreCommand.userId);
          }
        } else {
          if (this.ignoredUserRegistry) {
            await this.ignoredUserRegistry.remove(ignoreCommand.userId);
          } else {
            this.stateStore.unignoreUser(groupId, ignoreCommand.userId);
          }
        }
      } catch (error) {
        this.logger.error(`Ignore list update failed for ${ignoreCommand.userId}:`, error?.message ?? error);
        await this.apiClient.sendGroupMessage(groupId, '全局无视名单保存失败，请稍后重试');
        return;
      }

      this.logger.info('Ignore list updated for group:', JSON.stringify({
        group_id: groupId,
        action: ignoreCommand.action,
        ignored_user_id: ignoreCommand.userId,
      }));
      await this.apiClient.sendGroupMessage(groupId, ignoreCommand.action === 'ignore'
        ? `已无视 QQ${ignoreCommand.userId} 的发言`
        : `已取消无视 QQ${ignoreCommand.userId} 的发言`);
      return;
    }

    const isMotherModeToggleCommand = normalizedAtTriggeredCommand === normalizeCommandText('母on') || normalizedAtTriggeredCommand === normalizeCommandText('母off');
    const isSphereLightningToggleCommand = normalizedAtTriggeredCommand === normalizeCommandText('球形闪电on') || normalizedAtTriggeredCommand === normalizeCommandText('球形闪电off');
    const isSayCommand = normalizedAtTriggeredCommand.startsWith('say') || normalizeCommandText(messageText).startsWith(normalizeCommandText(sayCommandPrefix));

    const toggleTargetGroupId = remoteTargetGroupId ?? groupId;

    const motherModeState = this.stateStore.get(groupId);
    if (motherModeState.motherModeEnabled && !isMotherModeToggleCommand && !isSphereLightningToggleCommand && !isSayCommand) {
      const transformableText = extractTransformableText(event);
      if (transformableText && hasMotherModeTransformableText(transformableText)) {
        await this.apiClient.sendGroupMessage(groupId, transformMotherModeText(transformableText));
        return;
      }
    }

    if (isMotherModeToggleCommand) {
      const enabled = normalizedAtTriggeredCommand === normalizeCommandText('母on');
      this.stateStore.setMotherModeEnabled(toggleTargetGroupId, enabled);
      await this.apiClient.sendGroupMessage(groupId, enabled ? '母关式已开启' : '母关式已关闭');
      return;
    }

    if (isSphereLightningToggleCommand) {
      const enabled = normalizedAtTriggeredCommand === normalizeCommandText('球形闪电on');
      this.stateStore.setSphereLightningModeEnabled(toggleTargetGroupId, enabled);
      await this.apiClient.sendGroupMessage(groupId, enabled ? '球形闪电模式已开启' : '球形闪电模式已关闭');
      return;
    }

    if (questionToggleCommand) {
      const enabled = questionToggleCommand === 'enable';
      this.stateStore.setYesNoReplyEnabled(groupId, enabled);
      await this.apiClient.sendGroupMessage(groupId, enabled ? '问句随机应答已开启' : '问句随机应答已关闭');
      return;
    }

    if (repeatPlan) {
      const repeatState = this.stateStore.recordMessage(groupId, repeatPlan.signature);

      if (repeatState.lastMessageRepeatCount >= 3 && !repeatState.recentRepeatTriggers[repeatPlan.signature]) {
        this.logger.info(`Repeat triggered for group ${groupId}: ${repeatPlan.signature}`);
        this.stateStore.markRepeatTriggered(groupId, repeatPlan.signature);
        await this.apiClient.sendGroupMessage(groupId, repeatPlan.payload);
      }
    }

    if (normalizeCommandText(messageText) === normalizeCommandText(pingCommand) || normalizedAtTriggeredCommand === 'ping') {
      await this.apiClient.sendGroupMessage(groupId, 'pong');
      return;
    }

    const normalizedAtCommand = String(atTriggeredCommand ?? '').trim();

    if (normalizedAtCommand.startsWith(img2CommandPrefix)) {
      const rawImg2Input = normalizedAtCommand.slice(img2CommandPrefix.length).trim();
      const inlineReferenceUrls = extractReferenceImageUrlsFromText(rawImg2Input);
      const prompt = removeReferenceImageUrlsFromText(rawImg2Input);
      const imageUrls = [...extractImageUrls(event), ...inlineReferenceUrls];

      if (!prompt) {
        await this.apiClient.sendGroupMessage(groupId, '用法：@柯莱塔 img2 提示词（可附带图片作为参考图）');
        return;
      }

      try {
        await this.apiClient.sendGroupMessage(groupId, `正在生图，请稍等…（通常需要 30~90 秒，最长 ${this.img2Service.getImageApiTimeoutSeconds()} 秒）`);
        const outputImage = await this.img2Service.generateImg2({ prompt, imageUrls });
        const persistedImage = this.img2Service.persistOutputImage(outputImage);
        await this.apiClient.sendGroupMessage(groupId, this.img2Service.buildImageMessage(persistedImage));
      } catch (error) {
        this.logger.error(`img2 failed for group ${groupId}:`, error.stack ?? error.message);
        if (isLikelySendTimeout(error)) {
          this.logger.warn(`img2 image send may have succeeded despite timeout for group ${groupId}. Cache dir: ${this.img2Service.getImg2CacheDir()}`);
          return;
        }

        const errorMessage = String(error.message ?? '未知错误');
        let failureMessage = `生图失败了：${errorMessage}`;
        if (/图像接口|Image API/i.test(errorMessage)) {
          failureMessage = `生图接口失败：${errorMessage}`;
        } else if (/Upstream request failed/i.test(errorMessage)) {
          failureMessage = '生图服务上游暂时不可用，请稍后重试';
        } else if (/Failed to download reference image|参考图下载失败/i.test(errorMessage)) {
          failureMessage = `参考图下载失败：${errorMessage}`;
        } else if (/WebSocket is not open|not connected/i.test(errorMessage)) {
          failureMessage = '图已经生成，但发回群里失败了：当前连接已断开';
        }

        await this.apiClient.sendGroupMessage(groupId, failureMessage);
      }
      return;
    }

    if (normalizeCommandText(messageText) === normalizeCommandText(cancelLightningCommand) || normalizeCommandText(atTriggeredCommand ?? '') === normalizeCommandText('发射天气弹')) {
      const currentState = this.stateStore.get(groupId);
      if (!currentState.armed || currentState.armedCount <= 0) {
        await this.apiClient.sendGroupMessage(groupId, '现在没有闪电。');
        return;
      }

      this.stateStore.reset(groupId);
      await this.apiClient.sendGroupMessage(groupId, '天气弹发射成功，闪电驱散了！');
      return;
    }

    const arithmeticSource = atTriggeredCommand ?? '';
    if (arithmeticSource && isArithmeticExpression(arithmeticSource)) {
      try {
        await this.apiClient.sendGroupMessage(groupId, evaluateArithmeticExpression(arithmeticSource));
      } catch {
        await this.apiClient.sendGroupMessage(groupId, '不会算');
      }
      return;
    }

    if (atTriggeredCommand !== null && String(atTriggeredCommand).startsWith('rnd')) {
      let rndResult;
      try {
        rndResult = resolveRndCommand(atTriggeredCommand, this.random);
      } catch (error) {
        this.logger.warn(`rnd sampling failed for group ${groupId}:`, error?.message ?? error);
        rndResult = { kind: 'invalid-range' };
      }

      if (rndResult.kind === 'usage') {
        await this.apiClient.sendGroupMessage(groupId, RND_USAGE);
      } else if (rndResult.kind === 'invalid-range') {
        await this.apiClient.sendGroupMessage(groupId, RND_INVALID_RANGE);
      } else {
        await this.apiClient.sendGroupMessage(groupId, rndResult.value);
      }
      return;
    }

    if (normalizedAtTriggeredCommand.startsWith('say') || normalizeCommandText(messageText).startsWith(normalizeCommandText(sayCommandPrefix))) {
      const sayContent = normalizedAtTriggeredCommand.startsWith('say')
        ? atTriggeredCommandText.slice(3).trim()
        : messageText.slice(sayCommandPrefix.length).trim();

      if (remoteTargetGroupId) {
        if (!sayContent) {
          await this.apiClient.sendGroupMessage(groupId, REMOTE_USAGE);
          return;
        }

        await this.apiClient.sendGroupMessage(remoteTargetGroupId, sayContent);
        await this.apiClient.sendGroupMessage(groupId, `已发送到 ${remoteTargetGroupId}`);
        return;
      }

      if (sayContent) {
        await this.apiClient.sendGroupMessage(groupId, sayContent);
        return;
      }
    }

    if (normalizeCommandText(messageText) === normalizeCommandText(triggerCommand) || lightningIncrement !== null) {
      const botRole = await this.getBotGroupRole(groupId, event.self_id);
      if (botRole !== 'admin' && botRole !== 'owner') {
        await this.apiClient.sendGroupMessage(groupId, '烟不了捏');
        return;
      }

      const actionKey = rule.enabledActions[0] ?? 'temporaryMute';
      const nextState = this.stateStore.arm(groupId, actionKey, userId, lightningIncrement ?? 1);
      await this.apiClient.sendGroupMessage(groupId, formatLightningTriggerReply(rule.triggerReply, nextState.armedCount));
      this.logger.info(`Armed lightning mode for group ${groupId}, count=${nextState.armedCount}`);
      return;
    }

    if (yesNoReplyPlan) {
      const replyText = this.random() < 0.5 ? yesNoReplyPlan.positiveReply : yesNoReplyPlan.negativeReply;
      await this.apiClient.sendGroupMessage(groupId, replyText);
      return;
    }

    if (atTriggeredCommand !== null) {
      const chatPrompt = exactYesNoPrefixBody !== null
        ? exactYesNoPrefixBody
        : String(atTriggeredCommand ?? '').trim();
      if (!chatPrompt) {
        await this.apiClient.sendGroupMessage(groupId, '要我做什么？');
        return;
      }

      const isCompactCommand = normalizedAtTriggeredCommand === 'compact';
      const isNewCommand = normalizedAtTriggeredCommand === 'new';
      if (isCompactCommand || isNewCommand) {
        if (!botIsAdmin) {
          await this.apiClient.sendGroupMessage(groupId, '只有全局管理员可以管理聊天记忆');
          return;
        }

        if (!this.chatService) {
          await this.apiClient.sendGroupMessage(groupId, '聊天记忆功能尚未接入。');
          return;
        }

        if (isNewCommand) {
          this.chatService.clearTranscript(groupId);
          this.roleStore.clear(groupId);
          await this.apiClient.sendGroupMessage(groupId, '当前群记忆已清空');
          return;
        }

        try {
          const compactedTranscript = await this.chatService.compactTranscript(groupId, {
            prompt: this.getGroupPrompt(groupId),
            role: this.getSharedRole(groupId),
          });
          if (!Array.isArray(compactedTranscript) || compactedTranscript.length === 0) {
            await this.apiClient.sendGroupMessage(groupId, '当前群没有可压缩的聊天记忆');
            return;
          }

          await this.apiClient.sendGroupMessage(groupId, '当前群记忆已压缩');
        } catch (error) {
          this.logger.error(`Failed to compact chat memory for group ${groupId}:`, error?.stack ?? error?.message ?? error ?? '未知错误');
          await this.apiClient.sendGroupMessage(groupId, '当前群记忆压缩失败，请稍后重试');
        }

        return;
      }

      if (!this.chatService) {
        await this.apiClient.sendGroupMessage(groupId, '聊天功能尚未接入。');
        return;
      }

      try {
        const transcript = this.chatService.getTranscript(groupId);
        const prompt = this.getGroupPrompt(groupId);
        const role = this.getSharedRole(groupId);
        const contextMessages = [
          ...(prompt ? [{ role: 'system', content: prompt }] : []),
          ...(role ? [{ role: 'system', content: role }] : []),
        ];
        const replyText = await this.chatService.completeChat({
          messages: [...contextMessages, ...transcript, { role: 'user', content: chatPrompt }],
        });
        this.chatService.recordUserMessage(groupId, chatPrompt);
        this.chatService.recordAssistantMessage(groupId, replyText);
        await this.apiClient.sendGroupMessage(groupId, replyText);
      } catch (error) {
        const errorMessage = String(error?.message ?? error ?? '未知错误');
        const prefix = /CHAT_API_BASE_URL|CHAT_API_KEY/i.test(errorMessage) ? '聊天尚未配置' : '聊天失败了';
        await this.apiClient.sendGroupMessage(groupId, `${prefix}：${errorMessage}`);
      }

      return;
    }

    const state = this.stateStore.get(groupId);
    if (!state.armed) {
      return;
    }

    const executeLightningStrike = async (chosenUserId) => {
      const lightningState = this.stateStore.get(groupId);
      const sphereMultiplier = lightningState.sphereLightningModeEnabled
        ? calculateSphereLightningMultiplier(lightningState.armedCount, this.random)
        : 1;
      const action = this.actionRegistry.get(lightningState.activeActionKey);

      if (!action) {
        this.logger.warn(`Missing action executor for key ${lightningState.activeActionKey}`);
        this.stateStore.reset(groupId);
        return false;
      }

      try {
        await action.execute({
          apiClient: this.apiClient,
          groupId,
          userId: chosenUserId,
          durationSeconds: rule.muteDurationSeconds * sphereMultiplier,
          event,
        });
        const nextState = this.stateStore.consumeLightning(groupId);
        if (lightningState.sphereLightningModeEnabled) {
          const burstReply = formatSphereLightningBurstReply(sphereMultiplier);
          const remainingReply = formatLightningSuccessReply(rule.successReply, nextState.armedCount);
          await this.apiClient.sendGroupMessage(groupId, `${burstReply}${remainingReply}`);
        } else {
          await this.apiClient.sendGroupMessage(groupId, formatLightningSuccessReply(rule.successReply, nextState.armedCount));
        }

        return true;
      } catch (error) {
        this.logger.error(`Lightning strike failed for group ${groupId}:`, error.message);
        await this.apiClient.sendGroupMessage(groupId, rule.failureReply);
        return false;
      }
    };

    if (normalizeCommandText(messageText) === normalizeCommandText(forceLightningCommand)) {
      await executeLightningStrike(userId);
      return;
    }

    if (strikeMentionTarget) {
      const chosenUserId = this.random() < 0.5 ? userId : strikeMentionTarget;
      await executeLightningStrike(chosenUserId);
      return;
    }

    const roll = this.random();
    this.logger.debug(`Random roll for group ${groupId}: ${roll}`);
    if (roll >= rule.probability) {
      return;
    }

    await executeLightningStrike(userId);
  }
}
