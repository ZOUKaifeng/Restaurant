import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  PostmarkMailError,
  sendPostmarkMail,
  type PostmarkMailSettings,
  type PostmarkMessage,
} from '../src/postmark-mail.js';

const settings: PostmarkMailSettings = {
  serverToken: 'unit-only-secret-token',
  from: 'sender@example.test',
};
const message: PostmarkMessage = {
  to: 'recipient@example.test',
  subject: '订单通知',
  text: '仅用于单元测试的私密正文。',
  messageId: '<outbox-123@example.test>',
};
const providerId = '12345678-1234-1234-1234-123456789abc';
const accepted = { ErrorCode: 0, MessageID: providerId };
const externalMessage = [settings.serverToken, message.to, message.text,
  'https://api.postmarkapp.com/email'].join(' ');
const originalFetch = globalThis.fetch;
let realNetworkAttempts = 0;

before(() => {
  globalThis.fetch = async () => {
    realNetworkAttempts++;
    throw new Error('单元测试禁止真实网络访问');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(realNetworkAttempts, 0, '所有调用必须注入 mock fetch');
});

function mockedFetch(handler: typeof fetch) {
  const calls: { input: Parameters<typeof fetch>[0]; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return handler(input, init);
  };
  return { fetcher, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

async function expectCode(pending: Promise<unknown>, code: PostmarkMailError['code']) {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof PostmarkMailError);
    assert.equal(error.name, 'PostmarkMailError');
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
    for (const secret of [settings.serverToken, message.to, message.text,
      'https://api.postmarkapp.com/email']) {
      assert.ok(!String(error.stack).includes(secret), '错误不得包含外部私密内容');
    }
    return true;
  });
}

function readerResponse(
  status: number,
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  cancel: () => Promise<void>,
  releaseLock: () => void = () => {},
): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, 'body', {
    value: { getReader: () => ({ read, cancel, releaseLock }), cancel },
  });
  return response;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('成功请求仅使用固定 HTTPS、令牌头、隐私字段和供应商 UUID', async () => {
  const fake = mockedFetch(async () => jsonResponse({ ...accepted, Message: externalMessage }));
  assert.deepEqual(await sendPostmarkMail(settings, message, fake.fetcher), { messageId: providerId });
  assert.notEqual(providerId, message.messageId);
  assert.equal(fake.calls.length, 1);
  const { input, init } = fake.calls[0]!;
  assert.equal(input, 'https://api.postmarkapp.com/email');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
  assert.deepEqual(init.headers, {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Postmark-Server-Token': settings.serverToken,
  });
  assert.deepEqual(JSON.parse(String(init.body)), {
    From: settings.from, To: message.to, Subject: message.subject, TextBody: message.text,
    Headers: [{ Name: 'Message-ID', Value: message.messageId }],
    MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None',
  });
  assert.ok(!String(init.body).includes(settings.serverToken));
});

test('HTML与纯文本同时提交，保留禁跟踪设置与固定API', async () => {
  const html = '<html lang="en"><body><p>Verify your email</p></body></html>';
  const fake = mockedFetch(async () => jsonResponse(accepted));
  assert.deepEqual(await sendPostmarkMail(settings, { ...message, html }, fake.fetcher), { messageId: providerId });
  assert.equal(fake.calls.length, 1);
  const payload = JSON.parse(String(fake.calls[0]!.init?.body));
  assert.equal(payload.HtmlBody, html);
  assert.equal(payload.TextBody, message.text);
  assert.equal(payload.TrackLinks, 'None');
  assert.equal(payload.TrackOpens, false);
});

for (const html of ['', 123, 'x'.repeat(1024 * 1024 + 1), '汉'.repeat(400000)]) {
  test(`HTML输入拒绝不合法类型或超预算：${typeof html}-${String(html).length}，零外发`, async () => {
    const fake = mockedFetch(async () => jsonResponse(accepted));
    await expectCode(sendPostmarkMail(settings, { ...message, html } as PostmarkMessage, fake.fetcher), 'POSTMARK_CONFIG_INVALID');
    assert.equal(fake.calls.length, 0);
  });
}

const invalidSettings: [string, Partial<PostmarkMailSettings>][] = [
  ['空令牌', { serverToken: '' }],
  ['测试令牌', { serverToken: 'POSTMARK_API_TEST' }],
  ['占位令牌', { serverToken: 'CHANGE_ME' }],
  ['小写占位令牌', { serverToken: 'change_me' }],
  ['令牌超长', { serverToken: 'a'.repeat(513) }],
  ['令牌空格', { serverToken: 'bad token' }],
  ['令牌换行', { serverToken: 'token\n' }],
  ['令牌回车', { serverToken: 'token\r' }],
  ['令牌制表', { serverToken: 'token\t' }],
  ['令牌非 ASCII', { serverToken: '令牌' }],
  ['令牌 DEL', { serverToken: 'token\x7f' }],
  ['发件人为空', { from: '' }],
  ['发件人缺少邮箱', { from: 'sender' }],
  ['发件人显示名称', { from: 'Sender <sender@example.test>' }],
  ['发件人回车换行', { from: 'sender@example.test\r\nBcc: other@example.test' }],
  ['发件人尾换行', { from: 'sender@example.test\n' }],
  ['发件人多邮箱', { from: 'one@example.test,two@example.test' }],
];
for (const [label, change] of invalidSettings) {
  test(`配置预校验拒绝：${label}，零出站`, async () => {
    const fake = mockedFetch(async () => jsonResponse(accepted));
    await expectCode(sendPostmarkMail({ ...settings, ...change }, message, fake.fetcher),
      'POSTMARK_CONFIG_INVALID');
    assert.equal(fake.calls.length, 0);
  });
}

const invalidMessages: [string, Partial<PostmarkMessage>][] = [
  ['收件人为空', { to: '' }],
  ['收件人非邮箱', { to: 'recipient' }],
  ['收件人逗号', { to: 'one@example.test,two@example.test' }],
  ['收件人分号', { to: 'one@example.test;two@example.test' }],
  ['收件人空格', { to: ' recipient@example.test' }],
  ['收件人内部空格', { to: 'one @example.test' }],
  ['收件人制表', { to: 'recipient@example.test\t' }],
  ['收件人尾换行', { to: 'recipient@example.test\n' }],
  ['收件人回车换行', { to: 'recipient@example.test\r\n' }],
  ['收件人显示名称', { to: 'Recipient <recipient@example.test>' }],
  ['收件人非 ASCII', { to: '收件人@example.test' }],
  ['收件人超过 254', { to: `a@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}` }],
  ['收件人连续点', { to: 'one..two@example.test' }],
  ['收件人错误域名', { to: 'one@-example.test' }],
  ['主题超长', { subject: 'a'.repeat(2001) }],
  ['主题回车', { subject: 'title\rBcc: other@example.test' }],
  ['主题换行', { subject: 'title\n' }],
  ['正文超过字节上限', { text: 'a'.repeat(1024 * 1024 + 1) }],
  ['多字节正文超过上限', { text: '界'.repeat(Math.floor(1024 * 1024 / 3) + 1) }],
  ['消息 ID 缺少尖括号', { messageId: 'outbox@example.test' }],
  ['消息 ID 缺少主机', { messageId: '<outbox>' }],
  ['消息 ID 换行注入', { messageId: '<outbox@example.test>\r\nX: bad' }],
  ['消息 ID 尾换行', { messageId: '<outbox@example.test>\n' }],
  ['消息 ID 空格', { messageId: '<out box@example.test>' }],
  ['消息 ID 错误主机', { messageId: '<outbox@-example.test>' }],
  ['消息 ID 特殊符号', { messageId: '<outbox:bad@example.test>' }],
  ['消息 ID 超长', { messageId: `<${'a'.repeat(64)}@${'b'.repeat(63)}.test>` }],
];
for (const [label, change] of invalidMessages) {
  test(`消息预校验拒绝：${label}，零出站`, async () => {
    const fake = mockedFetch(async () => jsonResponse(accepted));
    await expectCode(sendPostmarkMail(settings, { ...message, ...change }, fake.fetcher),
      'POSTMARK_CONFIG_INVALID');
    assert.equal(fake.calls.length, 0);
  });
}

test('精确上限允许：512 令牌、254 邮箱、2000 主题、1 MiB 正文、128 消息 ID', async () => {
  const to = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const messageId = `<${'a'.repeat(60)}@${'b'.repeat(60)}.test>`;
  assert.equal(to.length, 254);
  assert.equal(messageId.length, 128);
  const fake = mockedFetch(async () => jsonResponse(accepted));
  assert.deepEqual(await sendPostmarkMail({ ...settings, serverToken: 'a'.repeat(512), from: to }, {
    ...message, to, messageId, subject: 'a'.repeat(2000), text: 'a'.repeat(1024 * 1024),
  }, fake.fetcher), { messageId: providerId });
  assert.equal(fake.calls.length, 1);
});

test('错误运行时字段类型也在出站前拒绝', async () => {
  const fake = mockedFetch(async () => jsonResponse(accepted));
  for (const field of ['serverToken', 'from'] as const) {
    await expectCode(sendPostmarkMail({ ...settings, [field]: 123 } as unknown as PostmarkMailSettings,
      message, fake.fetcher), 'POSTMARK_CONFIG_INVALID');
  }
  for (const field of ['to', 'subject', 'text', 'messageId'] as const) {
    await expectCode(sendPostmarkMail(settings,
      { ...message, [field]: null } as unknown as PostmarkMessage, fake.fetcher),
    'POSTMARK_CONFIG_INVALID');
  }
  await expectCode(sendPostmarkMail(null as unknown as PostmarkMailSettings, message, fake.fetcher),
    'POSTMARK_CONFIG_INVALID');
  await expectCode(sendPostmarkMail(settings, null as unknown as PostmarkMessage, fake.fetcher),
    'POSTMARK_CONFIG_INVALID');
  // 默认 fetch 同样不会在配置校验失败时被调用。
  await expectCode(sendPostmarkMail({ ...settings, serverToken: 'POSTMARK_API_TEST' }, message),
    'POSTMARK_CONFIG_INVALID');
  assert.equal(fake.calls.length, 0);
});

const rejections: [number, PostmarkMailError['code']][] = [
  [10, 'POSTMARK_AUTH_REJECTED'], [406, 'POSTMARK_RECIPIENT_INACTIVE'],
  [412, 'POSTMARK_ACCOUNT_NOT_APPROVED'], [413, 'POSTMARK_ACCOUNT_NOT_APPROVED'],
  [1235, 'POSTMARK_STREAM_REJECTED'], [1236, 'POSTMARK_STREAM_REJECTED'],
  [300, 'POSTMARK_REQUEST_REJECTED'],
];
for (const [errorCode, code] of rejections) {
  test(`HTTP 422 供应商拒绝 ${errorCode} 仅返回固定安全代码`, async (t) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ErrorCode: errorCode, Message: externalMessage }));
    let reads = 0;
    const cancel = t.mock.fn(async () => {});
    const response = readerResponse(422, async () => ++reads === 1
      ? { done: false, value: bytes } : { done: true, value: undefined }, cancel);
    const fake = mockedFetch(async () => response);
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), code);
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(fake.calls.length, 1);
  });
}

for (const [status, code] of [
  [401, 'POSTMARK_AUTH_REJECTED'], [429, 'POSTMARK_RATE_LIMITED'],
  [400, 'POSTMARK_REQUEST_REJECTED'], [413, 'POSTMARK_REQUEST_REJECTED'],
  [415, 'POSTMARK_REQUEST_REJECTED'],
] as const) {
  test(`HTTP ${status} 不读取外部响应并取消流`, async (t) => {
    const read = t.mock.fn(async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      throw new Error(externalMessage);
    });
    const cancel = t.mock.fn(async () => {});
    const fake = mockedFetch(async () => readerResponse(status, read, cancel));
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), code);
    assert.equal(read.mock.callCount(), 0);
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(fake.calls.length, 1);
  });
}

for (const status of [202, 204, 302, 404, 408, 500, 502, 503]) {
  test(`HTTP ${status} 保守归类未知且取消流`, async (t) => {
    const cancel = t.mock.fn(async () => {});
    const read = t.mock.fn(async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      throw new Error(externalMessage);
    });
    const fake = mockedFetch(async () => readerResponse(status, read, cancel));
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    assert.equal(read.mock.callCount(), 0);
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(fake.calls.length, 1);
  });
}

const malformedResults: [string, unknown][] = [
  ['字符串零', { ...accepted, ErrorCode: '0' }],
  ['字符串拒绝代码', { ...accepted, ErrorCode: '406' }],
  ['缺少错误代码', { MessageID: providerId }],
  ['布尔错误代码', { ...accepted, ErrorCode: false }],
  ['空错误代码', { ...accepted, ErrorCode: null }],
  ['非整数错误代码', { ...accepted, ErrorCode: 0.5 }],
  ['HTTP 200 非零代码', { ...accepted, ErrorCode: 406 }],
  ['缺少 UUID', { ErrorCode: 0 }],
  ['非字符串 UUID', { ...accepted, MessageID: 123 }],
  ['尖括号 SMTP ID', { ...accepted, MessageID: message.messageId }],
  ['无连字符 UUID', { ...accepted, MessageID: providerId.replaceAll('-', '') }],
  ['UUID 尾换行', { ...accepted, MessageID: `${providerId}\n` }],
  ['UUID 周围空格', { ...accepted, MessageID: ` ${providerId} ` }],
  ['UUID 非十六进制', { ...accepted, MessageID: providerId.replace('a', 'z') }],
  ['数组', [accepted]], ['空值', null], ['数字', 0],
];
for (const [label, data] of malformedResults) {
  test(`不确认投递：${label}`, async (t) => {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let reads = 0;
    const cancel = t.mock.fn(async () => {});
    const fake = mockedFetch(async () => readerResponse(200, async () => ++reads === 1
      ? { done: false, value: bytes } : { done: true, value: undefined }, cancel));
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(fake.calls.length, 1);
  });
}

for (const data of [{ ErrorCode: 0 }, { ErrorCode: '406' }, { ErrorCode: 406.5 }, {}, null]) {
  test(`HTTP 422 非有效拒绝代码 ${JSON.stringify(data)} 归类未知`, async () => {
    const fake = mockedFetch(async () => jsonResponse(data, 422));
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    assert.equal(fake.calls.length, 1);
  });
}

for (const status of [200, 422]) {
  test(`HTTP ${status} 无效 JSON、空响应或无效 UTF-8 归类未知`, async () => {
    for (const body of [externalMessage, '', '{', new Uint8Array([0xff])]) {
      const fake = mockedFetch(async () => new Response(body, { status }));
      await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
      assert.equal(fake.calls.length, 1);
    }
    const fake = mockedFetch(async () => new Response(null, { status }));
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
  });
}

test('正好 16 KiB 的分块响应成功，并允许大写 UUID', async () => {
  const raw = JSON.stringify({ ...accepted, MessageID: providerId.toUpperCase() });
  const bytes = new TextEncoder().encode(raw.padEnd(16 * 1024, ' '));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 5));
      controller.enqueue(bytes.slice(5));
      controller.close();
    },
  });
  const response = new Response(stream);
  const fake = mockedFetch(async () => response);
  assert.deepEqual(await sendPostmarkMail(settings, message, fake.fetcher),
    { messageId: providerId.toUpperCase() });
  assert.equal(response.body?.locked, false);
});

for (const status of [200, 422]) {
  test(`HTTP ${status} 超过 16 KiB 按字节拒绝并取消，不信任 Content-Length`, async (t) => {
    for (const split of [false, true]) {
      const cancel = t.mock.fn(async () => {});
      const raw = JSON.stringify(status === 200 ? accepted : { ErrorCode: 406 });
      const bytes = new TextEncoder().encode(raw.padEnd(16 * 1024 + 1, ' '));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (split) {
            controller.enqueue(bytes.slice(0, 16 * 1024));
            controller.enqueue(bytes.slice(16 * 1024));
          } else controller.enqueue(bytes);
        },
        cancel,
      });
      const fake = mockedFetch(async () => new Response(stream, {
        status, headers: { 'Content-Length': '1' },
      }));
      await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
      assert.equal(cancel.mock.callCount(), 1);
      assert.equal(fake.calls.length, 1);
      assert.equal(stream.locked, false);
    }
  });
}

test('供应商接受后响应丢失，以及流读取异常，均不能重试或暴露异常', async (t) => {
  const cancel = t.mock.fn(async () => { throw new Error(externalMessage); });
  let reads = 0;
  const fake = mockedFetch(async () => readerResponse(200, async () => {
    if (++reads === 1) return { done: false, value: new TextEncoder().encode(JSON.stringify(accepted)) };
    throw new Error(externalMessage);
  }, cancel));
  await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
  await flush();
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(fake.calls.length, 1);
});

test('网络异常、同步异常及伪装安全错误均被重新安全分类', async () => {
  for (const handler of [
    async () => { throw new Error(externalMessage); },
    () => { throw new Error(externalMessage); },
    async () => { throw new PostmarkMailError('POSTMARK_AUTH_REJECTED'); },
  ]) {
    const fake = mockedFetch(handler);
    await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    assert.equal(fake.calls.length, 1);
  }
});

test('fetch 不响应 abort 时，模拟 20 秒截止仍结束且取消迟到响应', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let resolve!: (response: Response) => void;
    const fake = mockedFetch(() => new Promise<Response>((done) => { resolve = done; }));
    const pending = expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    const signal = fake.calls[0]!.init!.signal!;
    t.mock.timers.tick(19_999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(fake.calls.length, 1);
    const cancel = t.mock.fn(async () => {});
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await flush();
    assert.equal(cancel.mock.callCount(), 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('原生流读取停滞且忽略 abort，仍按全程 20 秒截止取消', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cancel = t.mock.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}), cancel,
    });
    let resolve!: (response: Response) => void;
    const fake = mockedFetch(() => new Promise<Response>((done) => { resolve = done; }));
    const pending = expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    t.mock.timers.tick(12_000);
    resolve(new Response(stream));
    await flush();
    t.mock.timers.tick(7_999);
    assert.equal(fake.calls[0]!.init!.signal!.aborted, false);
    assert.equal(cancel.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(stream.locked, false);
    assert.equal(fake.calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('注入 reader 的 read 和 cancel 都停滞时不挂起，并尝试释放锁', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const read = t.mock.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const cancel = t.mock.fn(() => new Promise<void>(() => {}));
    const release = t.mock.fn(() => { throw new Error(externalMessage); });
    const fake = mockedFetch(async () => readerResponse(200, read, cancel, release));
    const pending = expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'DELIVERY_UNKNOWN');
    await flush();
    assert.equal(read.mock.callCount(), 1);
    t.mock.timers.tick(20_000);
    await pending;
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(release.mock.callCount(), 1);
    assert.equal(fake.calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('非 2xx 取消同步抛异常不得覆盖安全代码或触发未处理拒绝', async () => {
  const response = new Response(null, { status: 401 });
  Object.defineProperty(response, 'body', { value: { cancel() { throw new Error(externalMessage); } } });
  const fake = mockedFetch(async () => response);
  await expectCode(sendPostmarkMail(settings, message, fake.fetcher), 'POSTMARK_AUTH_REJECTED');
  assert.equal(fake.calls.length, 1);
});

test('成功、拒绝和异常后均清除截止计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const outcome of ['success', 'rejection', 'exception'] as const) {
      const fake = mockedFetch(async () => {
        if (outcome === 'exception') throw new Error(externalMessage);
        return jsonResponse(accepted, outcome === 'rejection' ? 429 : 200);
      });
      const pending = sendPostmarkMail(settings, message, fake.fetcher);
      if (outcome === 'success') await pending;
      else await expectCode(pending, outcome === 'rejection' ? 'POSTMARK_RATE_LIMITED' : 'DELIVERY_UNKNOWN');
      t.mock.timers.tick(100_000);
      assert.equal(fake.calls[0]!.init!.signal!.aborted, false);
      assert.equal(fake.calls.length, 1);
    }
    await flush();
  } finally {
    t.mock.timers.reset();
  }
});
