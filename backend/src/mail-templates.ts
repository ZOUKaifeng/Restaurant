export type AccountMailPurpose = 'verify_email' | 'reset_password';
export interface RenderedAccountMail { subject: string; text: string; html: string }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

// The caller creates this link from the configured origin and the decrypted token.
// Keep the same fragment-based action URL in both formats; a GET never performs the action.
export function renderAccountMail(purpose: AccountMailPurpose, actionUrl: URL): RenderedAccountMail {
  const verifying = purpose === 'verify_email';
  if (!verifying && purpose !== 'reset_password') throw new Error('Unsupported account email template');
  if (!['https:', 'http:'].includes(actionUrl.protocol) || actionUrl.username || actionUrl.password ||
      actionUrl.pathname !== (verifying ? '/auth/verify' : '/auth/reset') || actionUrl.search ||
      !/^#token=[A-Za-z0-9_-]{43}$/.test(actionUrl.hash)) {
    throw new Error('Invalid account email action link');
  }
  const subject = verifying ? 'Verify your email — Table Folk' : 'Reset your password — Table Folk';
  const title = verifying ? 'A little closer to your table.' : 'A fresh start for your account.';
  const intro = verifying
    ? 'Welcome to Table Folk. Confirm your email address to get started with your restaurant.'
    : 'We received a request to reset the password for your Table Folk account.';
  const button = verifying ? 'Verify email' : 'Reset password';
  const detail = verifying
    ? 'Open the link, then select “Verify and continue” to finish.'
    : 'The link opens a page where you can choose a new password. Opening it does not change your password.';
  const expiry = verifying ? 'This link expires 24 hours after it was requested.' : 'This link expires 30 minutes after it was requested.';
  const ignore = verifying
    ? 'If you did not create a Table Folk account, you can safely ignore this email.'
    : 'If you did not request a password reset, you can safely ignore this email. Your password will stay unchanged.';
  const preheader = verifying ? 'Confirm your email and make room for your restaurant.' : 'Choose a new password for your Table Folk account.';
  const url = escapeHtml(actionUrl.href);
  const text = [subject, '', intro, '', `${button}:`, actionUrl.href, '', detail, expiry, '', ignore, '', 'Table Folk', 'For the people behind the table.'].join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;width:100%;background-color:#ffffff;color:#242424;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;color:#ffffff;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#ffffff;"><tr><td align="center" style="padding:48px 20px 40px;">
<!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 0 46px;font-size:21px;line-height:28px;font-weight:400;color:#171717;letter-spacing:-0.5px;">Table Folk<span style="color:#8a8a8a;">.</span></td></tr>
<tr><td style="padding:0 0 14px;font-size:12px;line-height:18px;color:#777777;">${verifying ? 'Your email, confirmed.' : 'Your account, secured.'}</td></tr>
<tr><td style="padding:0 0 22px;"><h1 style="margin:0;font-size:30px;line-height:38px;font-weight:400;letter-spacing:-0.7px;color:#171717;">${escapeHtml(title)}</h1></td></tr>
<tr><td style="padding:0 0 28px;font-size:16px;line-height:26px;color:#4f4f4f;">${escapeHtml(intro)}</td></tr>
<tr><td align="left" style="padding:0 0 30px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#171717" style="background-color:#171717;border:1px solid #171717;mso-padding-alt:14px 28px;"><a href="${url}" style="display:inline-block;padding:14px 28px;font-size:14px;line-height:20px;font-family:Arial,Helvetica,sans-serif;color:#ffffff;background-color:#171717;text-decoration:none;font-weight:400;">${button}</a></td></tr></table></td></tr>
<tr><td style="padding:0 0 12px;font-size:13px;line-height:22px;color:#666666;">${escapeHtml(detail)}</td></tr>
<tr><td style="padding:0 0 14px;font-size:13px;line-height:22px;color:#666666;">${escapeHtml(expiry)}</td></tr>
<tr><td style="padding:0 0 34px;font-size:12px;line-height:20px;color:#777777;">Button not working? <a href="${url}" style="color:#4f4f4f;text-decoration:underline;">Open the ${verifying ? 'verification' : 'password reset'} link</a>.</td></tr>
<tr><td style="border-top:1px solid #e8e8e8;padding:24px 0 0;font-size:12px;line-height:20px;color:#777777;">${escapeHtml(ignore)}</td></tr>
<tr><td style="padding:24px 0 0;font-size:12px;line-height:20px;color:#888888;">Table Folk<br>For the people behind the table.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject, text, html };
}
