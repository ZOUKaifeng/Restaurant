import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import { legalPath } from './routing';
import type { RouteState } from './routing';
import type { RegistrationPolicy, SessionView } from './types';
import { acceptedMessage, ActionFeedback, ErrorNotice, LocaleSelect, PageLink, useAction } from './ui';
import type { Navigate } from './ui';

interface Props {
  route: RouteState;
  policy: RegistrationPolicy | null;
  policyError: unknown;
  policyLoading: boolean;
  reloadPolicy: () => void;
  navigate: Navigate;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onLogin: (session: SessionView) => void;
  onConsumed: (reset: boolean) => void;
}
const headings: Record<string, { title: string; text: string }> = {
  login: { title: '登录商家账户', text: '使用已验证的邮箱，继续管理餐厅资料。' },
  register: { title: '申请商家账户', text: '先验证邮箱，再创建餐厅草稿。' },
  forgot: { title: '找回密码', text: '申请重置链接。提交不会立即修改密码或撤销会话。' },
  resend: { title: '重新申请验证邮件', text: '填写注册邮箱。受理结果不透露账户是否存在。' },
  verify: { title: '验证邮箱', text: '只有点击确认后，才会提交此邮件中的验证请求。' },
  reset: { title: '设置新密码', text: '确认后重置密码，并撤销该账户的全部会话；不会自动登录。' },
};

export default function AuthView(props: Props) {
  const { route, policy, navigate, busy } = props;
  const page = route.page === 'home' ? 'login' : route.page;
  const heading = headings[page] ?? headings.login;
  const action = useAction(props.onBusyChange);
  const [completed, setCompleted] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  useEffect(() => { setAcceptedTerms(false); }, [policy?.terms_version]);
  const terms = legalPath(policy?.terms_url, 'terms');
  const privacy = legalPath(policy?.privacy_url, 'privacy');
  const isRegister = page === 'register';
  const isReset = page === 'reset';
  const isVerify = page === 'verify';
  const isEmailOnly = page === 'forgot' || page === 'resend';
  const tokenMissing = (isVerify || isReset) && !route.token && !completed;
  const policyBlocked = isRegister && (!policy || !terms || !privacy || policy.supported_locales.length === 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.pending || busy || completed || tokenMissing || policyBlocked || (isRegister && !acceptedTerms)) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = String(values.get('email') ?? '').trim();
    const password = String(values.get('password') ?? '');
    const passwordInput = form.elements.namedItem('password');
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
    const token = route.token;
    void action.run(async () => {
      if (page === 'login') {
        props.onLogin(await api.login({ email, password }));
        return;
      }
      if (isRegister && policy) {
        await api.register({
          email, password,
          display_name: String(values.get('display_name') ?? '').trim(),
          locale: String(values.get('locale') ?? ''),
          terms_version: policy.terms_version,
          accepted_terms: true,
        });
        form.reset();
        setCompleted(true);
        return acceptedMessage;
      }
      if (page === 'forgot' || page === 'resend') {
        if (page === 'forgot') await api.requestReset({ email });
        else await api.resendVerification({ email });
        form.reset();
        setCompleted(true);
        return acceptedMessage;
      }
      if (isVerify && token) {
        await api.verify({ token });
        setCompleted(true);
        props.onConsumed(false);
        return '邮箱验证成功。请自行登录，验证不会自动建立会话。';
      }
      if (isReset && token) {
        await api.reset({ token, new_password: password });
        setCompleted(true);
        props.onConsumed(true);
        return '密码已重置，该账户的全部会话已撤销。请使用新密码自行登录。';
      }
    });
  }

  return <section className="auth-layout">
    <div className="section-intro">
      <p className="eyebrow">账户 / {isRegister ? '注册' : isReset ? '重置' : isVerify ? '验证' : isEmailOnly ? '邮件申请' : '登录'}</p>
      <h1 tabIndex={-1}>{heading.title}</h1>
      <p className="muted intro-copy">{heading.text}</p>
      <p className="micro intro-footnote">仅处理账户与餐厅草稿。<br />菜单、发布和预约尚未实现。</p>
    </div>
    <div className="form-column">
      {isRegister && <>
        {props.policyLoading && <p role="status" className="micro">正在读取注册规则…</p>}
        <ErrorNotice error={props.policyError} />
        {!props.policyLoading && (Boolean(props.policyError) || policyBlocked) && <div className="notice">
          <p>注册需先读取当前规则与条款版本。</p>
          <button type="button" className="text-button" disabled={busy} onClick={props.reloadPolicy}>重新读取注册规则</button>
        </div>}
      </>}
      {tokenMissing && <div className="notice" role="status">
        <p>本页没有可用的邮件链接。令牌只保留在内存，刷新或离开后请重新打开原邮件；失效时请重新申请。</p>
        <PageLink href={isReset ? '/auth/forgot' : '/auth/resend'} navigate={navigate} disabled={busy}>重新申请邮件</PageLink>
      </div>}
      {!completed && <form onSubmit={submit} aria-busy={action.pending}>
        <fieldset disabled={busy || action.pending || policyBlocked || tokenMissing}>
          {!isReset && !isVerify && <div className="field">
            <label htmlFor="auth-email">邮箱</label>
            <input id="auth-email" name="email" type="email" autoComplete="username" inputMode="email" maxLength={254} required />
          </div>}
          {(page === 'login' || isRegister || isReset) && <div className="field">
            <label htmlFor="auth-password">{isReset ? '新密码' : '密码'}</label>
            <input id="auth-password" name="password" type="password" autoComplete={page === 'login' ? 'current-password' : 'new-password'} minLength={page === 'login' ? 1 : 15} maxLength={128} aria-describedby="password-help" required />
            <p className="micro" id="password-help">{page === 'login' ? '密码不会保存在浏览器存储中。' : '15–128 个字符，不截断密码。建议使用不重复的长密码。'}</p>
          </div>}
          {isRegister && <>
            <div className="field"><label htmlFor="display-name">称呼 <span className="muted">（可选）</span></label><input id="display-name" name="display_name" autoComplete="nickname" maxLength={100} /></div>
            {policy && <div className="field"><label htmlFor="account-locale">账户语言</label><LocaleSelect id="account-locale" name="locale" locales={policy.supported_locales} /></div>}
            <div className="terms-block">
              <p className="micro">正式内容尚未审核，当前为草案。条款确认不等于营销订阅。</p>
              <div className="inline-links">
                {terms && <PageLink href={terms} navigate={navigate} disabled={busy}>条款草案</PageLink>}
                {privacy && <PageLink href={privacy} navigate={navigate} disabled={busy}>隐私告知草案</PageLink>}
              </div>
              <button type="button" className="text-button" disabled={busy || props.policyLoading} onClick={props.reloadPolicy}>重新读取注册规则</button>
              <label className="check-field" htmlFor="accept-terms"><input id="accept-terms" name="accepted_terms" type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} required /><span>我已阅读并接受当前条款草案 {policy?.terms_version ?? ''}。</span></label>
            </div>
          </>}
          {isVerify && <p className="muted">邮件令牌已安全读取，不会显示在页面或浏览器地址中。</p>}
          <button className="primary-button" type="submit">{action.pending ? '正在处理…' : isRegister ? '申请注册' : isReset ? '确认重置密码' : isVerify ? '确认验证邮箱' : isEmailOnly ? '申请邮件' : '登录'}</button>
        </fieldset>
      </form>}
      <ActionFeedback action={action} />
      <nav className="auth-links" aria-label="账户操作">
        {page !== 'login' && <PageLink href="/auth/login" navigate={navigate} disabled={busy}>返回登录</PageLink>}
        {page === 'login' && <>
          <PageLink href="/auth/register" navigate={navigate} disabled={busy}>申请商家账户</PageLink>
          <PageLink href="/auth/forgot" navigate={navigate} disabled={busy}>忘记密码</PageLink>
          <PageLink href="/auth/resend" navigate={navigate} disabled={busy}>重新申请验证邮件</PageLink>
        </>}
      </nav>
    </div>
  </section>;
}
