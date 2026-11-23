import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import { legalPath } from './routing';
import type { RouteState } from './routing';
import type { RegistrationPolicy, SessionView } from './types';
import { acceptedMessage, ActionFeedback, ErrorNotice, LocaleSelect, PageLink, useAction } from './ui';
import type { Navigate } from './ui';
import './auth.css';

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
  login: { title: 'Welcome back', text: 'Sign in with your verified email to continue.' },
  register: { title: 'Start with your restaurant', text: 'Create an account, then verify your email to get started.' },
  forgot: { title: 'Reset password', text: 'Request a reset link. Your password and sessions stay unchanged until you confirm a new password.' },
  resend: { title: 'Verify your email', text: 'Request a new verification link using your registration email.' },
  verify: { title: 'Confirm your email', text: 'Ready when you are. Your email is verified only after you select the button below.' },
  reset: { title: 'Set a new password', text: 'Resetting your password revokes all sessions for this account. You will need to sign in again.' },
};

export default function AuthView(props: Props) {
  const { route, policy, navigate, busy } = props;
  const routePage: string = route.page;
  const page = routePage === 'home' || !Object.hasOwn(headings, routePage) ? 'login' : routePage;
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
        return 'Email verified. Sign in to continue; verification does not sign you in automatically.';
      }
      if (isReset && token) {
        await api.reset({ token, new_password: password });
        setCompleted(true);
        props.onConsumed(true);
        return 'Password reset. All sessions for this account have been revoked. Sign in with your new password.';
      }
    });
  }

  return <section className="tf-auth auth-layout">
    <aside className="auth-editorial" aria-label="The Table Folk approach">
      <img className="auth-image" src="/brand/bistro-interior.jpg" alt="A warmly lit bistro dining room with thoughtfully set tables" width={1000} height={800} />
      <div className="auth-brand-copy">
        <p className="eyebrow">Table Folk / For the people behind the table</p>
        <h2>Your restaurant.<br />More room to shine.</h2>
        <p>Thoughtful tools. Less noise. A little more space to focus on the place you make your own.</p>
      </div>
    </aside>
    <div className="form-column">
      <header className="auth-form-heading">
        <p className="eyebrow">Your Table Folk account</p>
        <h1 tabIndex={-1}>{heading.title}</h1>
        <p className="muted intro-copy">{heading.text}</p>
      </header>
      {isRegister && <>
        {props.policyLoading && <p role="status" className="micro">Loading registration requirements…</p>}
        <ErrorNotice error={props.policyError} />
        {!props.policyLoading && (Boolean(props.policyError) || policyBlocked) && <div className="notice">
          <p>The current registration requirements and terms version must be loaded before you can continue.</p>
          <button type="button" className="text-button" disabled={busy} onClick={props.reloadPolicy}>Reload registration requirements</button>
        </div>}
      </>}
      {tokenMissing && <div className="notice" role="status">
        <p>No email link is available on this page. Links are kept in memory only. After refreshing or leaving, reopen the original email link. If it has expired, request a new one.</p>
        <PageLink href={isReset ? '/auth/forgot' : '/auth/resend'} navigate={navigate} disabled={busy}>Request a new email link</PageLink>
      </div>}
      {!completed && <form onSubmit={submit} aria-busy={action.pending}>
        <fieldset disabled={busy || action.pending || policyBlocked || tokenMissing}>
          {!isReset && !isVerify && <div className="field">
            <label htmlFor="auth-email">Email address</label>
            <input id="auth-email" name="email" type="email" autoComplete="username" inputMode="email" maxLength={254} required />
          </div>}
          {(page === 'login' || isRegister || isReset) && <div className="field">
            <label htmlFor="auth-password">{isReset ? 'New password' : 'Password'}</label>
            <input id="auth-password" name="password" type="password" autoComplete={page === 'login' ? 'current-password' : 'new-password'} minLength={page === 'login' ? 1 : 15} maxLength={128} aria-describedby="password-help" required />
            <p className="micro" id="password-help">{page === 'login' ? 'Your password is not saved in local or session storage.' : 'Use 15–128 characters. Choose a long, unique password; it will not be truncated.'}</p>
          </div>}
          {isRegister && <>
            <div className="field"><label htmlFor="display-name">Display name <span className="muted">(optional)</span></label><input id="display-name" name="display_name" autoComplete="nickname" maxLength={100} /></div>
            {policy && <div className="field"><label htmlFor="account-locale">Language</label><LocaleSelect id="account-locale" name="locale" locales={policy.supported_locales} /></div>}
            <div className="terms-block">
              <p className="auth-legal-note"><strong>Draft legal documents</strong>The terms and privacy notice below are drafts and have not completed review. Accepting the terms does not subscribe you to marketing.</p>
              <div className="inline-links">
                {terms && <PageLink href={terms} navigate={navigate} disabled={busy}>Draft terms</PageLink>}
                {privacy && <PageLink href={privacy} navigate={navigate} disabled={busy}>Draft privacy notice</PageLink>}
              </div>
              <button type="button" className="text-button" disabled={busy || props.policyLoading} onClick={props.reloadPolicy}>Reload registration requirements</button>
              <label className="check-field" htmlFor="accept-terms"><input id="accept-terms" name="accepted_terms" type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} required /><span>I have read and accept the current draft terms (version {policy?.terms_version ?? ''}).</span></label>
            </div>
          </>}
          {isVerify && <p className="muted auth-verification-note">Verification does not sign you in automatically. The email link token is never displayed on this page or in the address bar.</p>}
          <button className="primary-button" type="submit">{action.pending ? 'Working…' : isRegister ? 'Create account' : isReset ? 'Confirm new password' : isVerify ? 'Verify email' : isEmailOnly ? 'Request email link' : 'Sign in'}</button>
        </fieldset>
      </form>}
      <ActionFeedback action={action} />
      {completed && isRegister && <p className="auth-completion-note">Follow the verification link if it arrives, then sign in. Need another link? Request a new verification email below.</p>}
      <nav className="auth-links" aria-label="Account actions">
        {page !== 'login' && <PageLink href="/auth/login" navigate={navigate} disabled={busy}>Back to sign in</PageLink>}
        {completed && isRegister && <PageLink href="/auth/resend" navigate={navigate} disabled={busy}>Request another verification email</PageLink>}
        {page === 'login' && <>
          <PageLink href="/auth/register" navigate={navigate} disabled={busy}>Create an account</PageLink>
          <PageLink href="/auth/forgot" navigate={navigate} disabled={busy}>Forgot password?</PageLink>
          <PageLink href="/auth/resend" navigate={navigate} disabled={busy}>Request a verification email</PageLink>
        </>}
      </nav>
    </div>
  </section>;
}
