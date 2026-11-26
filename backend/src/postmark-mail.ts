import { Buffer } from 'node:buffer';

export type PostmarkMailSettings = {
  serverToken: string;
  from: string;
};

export type PostmarkMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
};

type PostmarkMailErrorCode =
  | 'DELIVERY_UNKNOWN'
  | 'POSTMARK_AUTH_REJECTED'
  | 'POSTMARK_RECIPIENT_INACTIVE'
  | 'POSTMARK_ACCOUNT_NOT_APPROVED'
  | 'POSTMARK_STREAM_REJECTED'
  | 'POSTMARK_REQUEST_REJECTED'
  | 'POSTMARK_RATE_LIMITED'
  | 'POSTMARK_CONFIG_INVALID';

export class PostmarkMailError extends Error {
  constructor(readonly code: PostmarkMailErrorCode) {
    super(code);
    this.name = 'PostmarkMailError';
  }
}

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAILBOX = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const PROVIDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMailbox(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && !/[\s,]/.test(value) &&
    MAILBOX.test(value) && value.indexOf('@') <= 64;
}

function validate(settings: PostmarkMailSettings, message: PostmarkMessage): void {
  if (!settings || !message ||
      typeof settings.serverToken !== 'string' ||
      settings.serverToken.length === 0 || settings.serverToken.length > 512 ||
      /[^!-~]/.test(settings.serverToken) ||
      /^(POSTMARK_API_TEST|CHANGE_ME)$/i.test(settings.serverToken) ||
      !isMailbox(settings.from) || !isMailbox(message.to) ||
      typeof message.subject !== 'string' || message.subject.length > 2000 ||
      /[\r\n]/.test(message.subject) ||
      typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > 1024 * 1024 ||
      (message.html !== undefined && (typeof message.html !== 'string' || message.html.length === 0 || Buffer.byteLength(message.html, 'utf8') > 1024 * 1024)) ||
      typeof message.messageId !== 'string' || message.messageId.length > 128 ||
      !/^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+>$/.test(message.messageId) ||
      !isMailbox(message.messageId.slice(1, -1))) {
    throw new PostmarkMailError('POSTMARK_CONFIG_INVALID');
  }
}

function rejectionCode(code: number): PostmarkMailErrorCode {
  switch (code) {
    case 10: return 'POSTMARK_AUTH_REJECTED';
    case 406: return 'POSTMARK_RECIPIENT_INACTIVE';
    case 412:
    case 413: return 'POSTMARK_ACCOUNT_NOT_APPROVED';
    case 1235:
    case 1236: return 'POSTMARK_STREAM_REJECTED';
    default: return 'POSTMARK_REQUEST_REJECTED';
  }
}

export async function sendPostmarkMail(
  settings: PostmarkMailSettings,
  message: PostmarkMessage,
  fetcher: typeof fetch = fetch,
): Promise<{ messageId: string }> {
  validate(settings, message);
  const payload = JSON.stringify({
    From: settings.from,
    To: message.to,
    Subject: message.subject,
    TextBody: message.text,
    ...(message.html !== undefined ? { HtmlBody: message.html } : {}),
    Headers: [{ Name: 'Message-ID', Value: message.messageId }],
    MessageStream: 'outbound',
    TrackOpens: false,
    TrackLinks: 'None',
  });
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let knownRejection: PostmarkMailErrorCode | undefined;
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new PostmarkMailError('DELIVERY_UNKNOWN'));
    }, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // 取消不等待：注入的流可能连 cancel() 都不响应。
  function cancelBody(target: Response | undefined = response): void {
    try {
      const cancellation = target === response && reader
        ? reader.cancel()
        : target?.body?.cancel();
      void cancellation?.catch(() => {});
    } catch {
      // 外部流的异常不得替换安全错误或泄露响应内容。
    }
  }

  try {
    const pending = Promise.resolve(fetcher('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': settings.serverToken,
      },
      body: payload,
      signal: controller.signal,
      redirect: 'error',
    })).then((result) => {
      // 即使注入的 fetch 忽略 abort 并迟到，仍丢弃其响应。
      if (controller.signal.aborted) cancelBody(result);
      return result;
    });
    response = await Promise.race([pending, deadline]);

    if (response.status === 401) knownRejection = 'POSTMARK_AUTH_REJECTED';
    else if (response.status === 429) knownRejection = 'POSTMARK_RATE_LIMITED';
    else if ([400, 413, 415].includes(response.status)) knownRejection = 'POSTMARK_REQUEST_REJECTED';
    if (knownRejection || (response.status !== 200 && response.status !== 422)) {
      throw new PostmarkMailError('DELIVERY_UNKNOWN');
    }

    if (!response.body) throw new PostmarkMailError('DELIVERY_UNKNOWN');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      // 一个共享截止时间覆盖 fetch 和全部读取；不依赖流响应 abort。
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > MAX_RESPONSE_BYTES - size) {
        throw new PostmarkMailError('DELIVERY_UNKNOWN');
      }
      size += chunk.value.byteLength;
      if (chunk.value.byteLength > 0) chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new PostmarkMailError('DELIVERY_UNKNOWN');
    }
    const result = data as Record<string, unknown>;
    if (typeof result.ErrorCode !== 'number' || !Number.isInteger(result.ErrorCode)) {
      throw new PostmarkMailError('DELIVERY_UNKNOWN');
    }
    if (response.status === 422 && result.ErrorCode !== 0) {
      knownRejection = rejectionCode(result.ErrorCode);
      throw new PostmarkMailError('DELIVERY_UNKNOWN');
    }
    if (response.status !== 200 || result.ErrorCode !== 0 ||
        typeof result.MessageID !== 'string' || result.MessageID.length !== 36 ||
        !PROVIDER_ID.test(result.MessageID)) {
      throw new PostmarkMailError('DELIVERY_UNKNOWN');
    }
    completed = true;
    return { messageId: result.MessageID };
  } catch {
    // 不透传供应商 Message、原始异常、cause、地址或令牌。
    throw new PostmarkMailError(knownRejection ?? 'DELIVERY_UNKNOWN');
  } finally {
    clearTimeout(timer);
    if (!completed) cancelBody();
    try { reader?.releaseLock(); } catch { /* 仍在读取的外部流也不能泄露异常。 */ }
  }
}
