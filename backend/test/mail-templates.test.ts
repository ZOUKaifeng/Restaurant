import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAccountMail, type AccountMailPurpose } from '../src/mail-templates.js';

const token = 'a'.repeat(43);
const copies = {
  verify_email: {
    path: '/auth/verify',
    subject: 'Verify your email — Table Folk',
    title: 'A little closer to your table.',
    button: 'Verify email',
    fallback: 'Open the verification link',
    preheader: 'Confirm your email and make room for your restaurant.',
    eyebrow: 'Your email, confirmed.',
    intro: 'Welcome to Table Folk. Confirm your email address to get started with your restaurant.',
    detail: 'Open the link, then select “Verify and continue” to finish.',
    expiry: 'This link expires 24 hours after it was requested.',
    ignore: 'If you did not create a Table Folk account, you can safely ignore this email.',
  },
  reset_password: {
    path: '/auth/reset',
    subject: 'Reset your password — Table Folk',
    title: 'A fresh start for your account.',
    button: 'Reset password',
    fallback: 'Open the password reset link',
    preheader: 'Choose a new password for your Table Folk account.',
    eyebrow: 'Your account, secured.',
    intro: 'We received a request to reset the password for your Table Folk account.',
    detail: 'The link opens a page where you can choose a new password. Opening it does not change your password.',
    expiry: 'This link expires 30 minutes after it was requested.',
    ignore: 'If you did not request a password reset, you can safely ignore this email. Your password will stay unchanged.',
  },
} satisfies Record<AccountMailPurpose, Record<string, string>>;
const purposes = Object.keys(copies) as AccountMailPurpose[];

function actionUrl(purpose: AccountMailPurpose, origin = 'https://app.example.test'): URL {
  return new URL(`${copies[purpose].path}#token=${token}`, origin);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()]!;
    return String.fromCodePoint(entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });
}

function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function visibleText(html: string): string {
  return decodeEntities(withoutComments(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((match) => [match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4])]));
}

function links(html: string) {
  return [...withoutComments(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ attrs: attributes(`<a${match[1]}>`), text: visibleText(match[2]) }));
}

for (const purpose of purposes) {
  const copy = copies[purpose];

  test(`${purpose}：主题、标题、按钮及说明均为英文，明确打开链接不会自动执行操作`, () => {
    const mail = renderAccountMail(purpose, actionUrl(purpose));
    assert.equal(mail.subject, copy.subject);
    assert.equal(visibleText(mail.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)![1]), copy.subject);
    assert.equal(visibleText(mail.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)![1]), copy.title);
    assert.deepEqual(links(mail.html).map((link) => link.text), [copy.button, copy.fallback]);
    const prose = visibleText(mail.html);
    for (const text of [copy.preheader, copy.eyebrow, copy.intro, copy.detail, copy.expiry, copy.ignore,
      'Button not working?', 'Table Folk', 'For the people behind the table.']) {
      assert.ok(prose.includes(text), `缺少英文文案：${text}`);
    }
    assert.doesNotMatch(mail.subject + mail.text + prose, /\p{Script=Han}/u);
  });

  test(`${purpose}：按钮和备用链接精确保留 token 片段，纯文本只有一个完整 URL`, () => {
    const url = actionUrl(purpose);
    const mail = renderAccountMail(purpose, url);
    assert.deepEqual(links(mail.html).map((link) => link.attrs.href), [url.href, url.href]);
    assert.equal(mail.text, [copy.subject, '', copy.intro, '', `${copy.button}:`, url.href, '',
      copy.detail, copy.expiry, '', copy.ignore, '', 'Table Folk', 'For the people behind the table.'].join('\n'));
    assert.deepEqual(mail.text.match(/https?:\/\/[^\s]+/g), [url.href]);
    assert.equal(mail.text.split(token).length - 1, 1);
    assert.ok(mail.html.includes(`#token=${token}`));
    assert.ok(!visibleText(mail.html).includes(token), '标题、段落和链接标签不得显示 token');
    assert.equal(url.search, '');
    assert.equal(url.hash, `#token=${token}`);
  });

  test(`${purpose}：英文语言、展示表格、560px 内联布局且无脚本、表单或外部资源`, () => {
    const { html } = renderAccountMail(purpose, actionUrl(purpose));
    const markup = withoutComments(html);
    assert.equal(attributes(markup.match(/<html\b[^>]*>/i)![0]).lang, 'en');
    const tables = [...markup.matchAll(/<table\b[^>]*>/gi)].map((match) => attributes(match[0]));
    assert.ok(tables.length >= 2);
    for (const table of tables) {
      assert.equal(table.role, 'presentation');
      assert.equal(table.cellspacing, '0');
      assert.equal(table.cellpadding, '0');
      assert.equal(table.border, '0');
      if (table.width === '100%') assert.match(table.style, /width\s*:\s*100%/i);
    }
    assert.ok(tables.some((table) => /max-width\s*:\s*560px/i.test(table.style ?? '')));
    const maxWidths = [...markup.matchAll(/max-width\s*:\s*(\d+)px/gi)].map((match) => Number(match[1]));
    assert.ok(maxWidths.includes(560));
    assert.ok(maxWidths.every((width) => width <= 560));
    assert.ok(links(html).every((link) => Boolean(link.attrs.style)));
    assert.doesNotMatch(html, /<(?:script|form|input|button|iframe|object|embed|img|svg|video|audio|link|style|base)\b/i);
    assert.doesNotMatch(html, /\son\w+\s*=|\s(?:src|srcset|action|formaction|ping)\s*=|@import|@font-face|url\s*\(|javascript:|data:/i);
    assert.doesNotMatch(html, /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i);
    assert.equal((html.match(/https?:\/\//g) ?? []).length, 2, '仅允许两个原样操作链接，不允许跟踪地址');
  });
}

test('合法 HTTPS 主机中的引号正确转义，Unicode 主机规范化后链接保持不变', () => {
  for (const purpose of purposes) {
    for (const origin of ["https://app'edge.example.test", 'https://café.example.test']) {
      const url = actionUrl(purpose, origin);
      const { html, text } = renderAccountMail(purpose, url);
      assert.deepEqual(links(html).map((link) => link.attrs.href), [url.href, url.href]);
      assert.deepEqual(text.match(/https?:\/\/[^\s]+/g), [url.href]);
      if (url.hostname.includes("'")) {
        assert.ok(html.includes('&#39;'));
        assert.ok(!html.includes(url.href), 'HTML 属性中不能保留未转义的引号');
      } else {
        assert.match(url.hostname, /^xn--/);
      }
      assert.ok(!visibleText(html).includes(token));
    }
  }
});

test('拒绝不支持的用途，包括 querytext', () => {
  for (const purpose of ['querytext', 'verify', 'VERIFY_EMAIL', '']) {
    assert.throws(() => renderAccountMail(purpose as AccountMailPurpose, actionUrl('verify_email')),
      /Unsupported account email template/);
  }
});

test('拒绝脚本、数据协议、凭据、错误或编码路径、查询参数和缺失片段', () => {
  for (const purpose of purposes) {
    const valid = actionUrl(purpose);
    const invalidUrls = [new URL(`javascript:alert(1)#token=${token}`), new URL(`data:text/plain,test#token=${token}`)];
    for (const [field, value] of [
      ['username', 'user'], ['password', 'secret'],
      ['pathname', purpose === 'verify_email' ? '/auth/reset' : '/auth/verify'],
      ['pathname', `${copies[purpose].path}/`],
      ['pathname', `${copies[purpose].path}/餐厅"`],
      ['pathname', copies[purpose].path.replace('/auth/', '/%61uth/')],
      ['search', '?querytext=unsupported'], ['search', `?token=${token}`],
      ['hash', ''],
    ] as const) {
      const url = new URL(valid.href);
      url[field] = value;
      invalidUrls.push(url);
    }
    for (const url of invalidUrls) {
      assert.throws(() => renderAccountMail(purpose, url), /Invalid account email action link/);
    }
  }
});

test('拒绝错误 token 名称、长度、字符、编码及附加参数', () => {
  for (const purpose of purposes) {
    for (const hash of ['#token=', `#token=${'a'.repeat(42)}`, `#token=${'a'.repeat(44)}`,
      `#access_token=${token}`, `#Token=${token}`, `#token=${'a'.repeat(42)}+`,
      `#token=${'a'.repeat(42)}/`, `#token=%61${'a'.repeat(42)}`, `#token=${token}&extra=1`,
      `#token=${token}&token=${token}`]) {
      const url = actionUrl(purpose);
      url.hash = hash;
      assert.throws(() => renderAccountMail(purpose, url), /Invalid account email action link/);
    }
  }
});

test('合法的大小写字母、数字、下划线和短横线 token 原样保留', () => {
  const validToken = `Ab09_-${'Z'.repeat(37)}`;
  for (const purpose of purposes) {
    const url = actionUrl(purpose);
    url.hash = `token=${validToken}`;
    const { html, text } = renderAccountMail(purpose, url);
    assert.deepEqual(links(html).map((link) => link.attrs.href), [url.href, url.href]);
    assert.deepEqual(text.match(/https?:\/\/[^\s]+/g), [url.href]);
    assert.ok(!visibleText(html).includes(validToken));
  }
});
