import { useEffect, useRef, useState } from 'react';
import { readUsage } from './usage-client';
import { formatUsageCreditBalance } from './usage-credits';
import { PageLink, type Navigate } from './ui';

type BalanceState = 'loading' | 'not_configured' | 'unavailable' | 'available';
export function TokenBalanceView({ state, availableTokens, navigate, busy }: {
  state: BalanceState; availableTokens?: number; navigate: Navigate; busy: boolean;
}) {
  const value = state === 'available'
    ? typeof availableTokens === 'number' && Number.isSafeInteger(availableTokens) ? formatUsageCreditBalance(availableTokens) : 'Unavailable'
    : state === 'not_configured' ? 'Not configured' : state === 'unavailable' ? 'Unavailable' : '—';
  return <PageLink href="/account/usage" navigate={navigate} disabled={busy} className="management-token-balance">
    <span aria-live="polite">Credits left · {value}</span>
  </PageLink>;
}

export default function TokenBalance({ userId, active, refreshKey, navigate, busy }: {
  userId: string; active: boolean; refreshKey: string; navigate: Navigate; busy: boolean;
}) {
  const live = useRef({ userId, active, refreshKey, scope: 0 });
  if (live.current.userId !== userId || live.current.active !== active || live.current.refreshKey !== refreshKey) {
    live.current = { userId, active, refreshKey, scope: live.current.scope + 1 };
  }
  const scope = live.current.scope;
  const [result, setResult] = useState<{ scope: number; state: BalanceState; availableTokens?: number }>({ scope, state: 'loading' });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const valid = () => !controller.signal.aborted && live.current.scope === scope;
    setResult({ scope, state: 'loading' });
    const read = () => {
      if (!valid()) return;
      void readUsage({}, controller.signal).then(report => {
        if (!valid()) return;
        // 只使用完整报表校验后的真实余额，绝不以授额减历史累计推算。
        setResult(report.quota.configured
          ? { scope, state: 'available', availableTokens: report.quota.available_tokens }
          : { scope, state: 'not_configured' });
        // Active test balances refresh without blocking an ongoing model job.
        // Sequential timeouts ensure only one read is in flight at a time.
        if (report.quota.configured) timer = window.setTimeout(read, 30_000);
      }).catch(() => {
        if (valid()) setResult({ scope, state: 'unavailable' });
      });
    };
    read();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [userId, active, refreshKey, scope]);
  if (!active) return null;
  return <TokenBalanceView state={result.scope === scope ? result.state : 'loading'}
    availableTokens={result.scope === scope ? result.availableTokens : undefined} navigate={navigate} busy={busy} />;
}
