import { useEffect, useRef, useState } from 'react';
import { reservationApi, reservationSettingsError, type ReservationSettingsView } from './reservation-api';

export function ReservationSettingsPanel({ restaurantId, active }: { restaurantId: string; active: boolean }) {
  const [settings, setSettings] = useState<ReservationSettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flight.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!active) { flight.current?.abort(); flight.current = null; return; }
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true);
    setError(null);
    setSaved(false);
    reservationApi.settings(restaurantId, controller.signal).then(value => {
      if (!mounted.current || controller.signal.aborted) return;
      setSettings(value);
      setEnabled(value.enabled);
      setNotice(value.notice ?? '');
      setPrivacy(value.privacy_notice_version ?? '');
    }).catch(caught => {
      if (mounted.current && !controller.signal.aborted) setError(caught);
    }).finally(() => {
      if (flight.current === controller) { flight.current = null; setLoading(false); }
    });
    return () => controller.abort();
  }, [restaurantId, active, reload]);

  async function save() {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await reservationApi.updateSettings(restaurantId, {
        enabled, notice: notice.trim() || null,
        ...(privacy.trim() ? { privacy_notice_version: privacy.trim() } : {}),
        expected_revision: settings.restaurant_revision,
      });
      if (!mounted.current) return;
      setSettings(next);
      setEnabled(next.enabled);
      setSaved(true);
    } catch (caught) {
      if (mounted.current) setError(caught);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const accepts = settings?.intervals.some(interval => interval.accepts_requests) ?? false;
  const missing = enabled && settings ? [
    !settings.timezone ? '时区' : '',
    !privacy.trim() ? '隐私说明版本' : '',
    !accepts ? '至少一个“允许申请”的营业段' : '',
  ].filter(Boolean) : [];
  const heading = `reservation-settings-${restaurantId}`;
  return <section className="website-section" aria-labelledby={heading}>
    <div className="row-heading"><h3 id={heading}>00 / 在线订位设置</h3><button type="button" className="text-button" disabled={loading || saving || !active} onClick={() => setReload(value => value + 1)}>重新读取</button></div>
    <p className="micro">开启后，新生成的网页会带平台固定的订位入口；顾客提交的是申请，仍需你在预订记录中确认。网页模型不能修改这里的状态，也不能伪造订位成功。</p>
    {loading && <p className="micro loading-text" role="status">正在读取订位设置…</p>}
    {!loading && !settings && error !== null && <p className="notice" role="alert">{reservationSettingsError(error)}</p>}
    {settings && <>
      <label className="check-field"><input type="checkbox" checked={enabled} disabled={saving} onChange={event => { setEnabled(event.target.checked); setSaved(false); }} /><span>允许顾客在线提交订位申请</span></label>
      <div className="field"><label htmlFor={`${heading}-notice`}>给顾客的说明（可选，最多 2000 字）</label><textarea id={`${heading}-notice`} rows={3} maxLength={2000} value={notice} disabled={saving} onChange={event => { setNotice(event.target.value); setSaved(false); }} placeholder="例如：提交后餐厅会电话或邮件确认；节假日可能无法接受。" /><span className="micro">{notice.length} / 2000</span></div>
      <div className="field"><label htmlFor={`${heading}-privacy`}>隐私说明版本</label><input id={`${heading}-privacy`} value={privacy} maxLength={64} disabled={saving} onChange={event => { setPrivacy(event.target.value); setSaved(false); }} placeholder="例如 privacy-v1" /><span className="micro">必须与网站展示的隐私说明一致，否则公开提交会被拒绝。</span></div>
      {missing.length > 0 && <p className="notice" role="status">开启前还需要：{missing.join('、')}。请先在餐厅资料和营业时间中补齐。</p>}
      <div className="save-row"><button type="button" disabled={saving || loading || missing.length > 0} onClick={() => void save()}>{saving ? '保存中…' : '保存订位设置'}</button></div>
      {error !== null && <p className="notice" role="alert">{reservationSettingsError(error)}</p>}
      {saved && <p className="notice" role="status">已保存。餐厅版本已更新，正在使用的网页生成确认需要重新核对；刷新页面后再继续生成或发布。<button type="button" className="text-button" onClick={() => window.location.reload()}>刷新页面</button></p>}
      <p className="micro">停订只影响新提交与公开入口，不会删除已有预订；已发布旧网页在重新生成前仍显示旧内容。</p>
    </>}
  </section>;
}
