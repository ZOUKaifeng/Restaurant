import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from './api';
import AssetsPanel from './AssetsPanel';
import { profileFields, profilePatch, toProfileDraft } from './profile';
import type { ProfileDraft } from './profile';
import type { OpeningHoursView, OpeningInterval, Restaurant, Versioned } from './types';
import { ActionFeedback, ErrorNotice, fieldLabels, useAction } from './ui';

type Snapshot = { restaurant: Versioned<Restaurant>; hours: Versioned<OpeningHoursView> };
type HourRow = { key: string; interval: OpeningInterval };
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const statusLabels = { draft: '草稿', active: '已启用', suspended: '已暂停', archived: '已归档' };
function toHourRows(intervals: OpeningInterval[]): HourRow[] {
  return intervals.map((interval) => ({ key: crypto.randomUUID(), interval: { ...interval } }));
}
async function readSnapshot(id: string, signal?: AbortSignal): Promise<Snapshot> {
  const restaurant = await api.restaurant(id, signal);
  const hours = await api.hours(id, signal);
  if (restaurant.etag !== hours.etag) throw new ApiError(412, 'REVISION_CONFLICT');
  return { restaurant, hours };
}
function requiresRefresh(error: unknown) {
  return error instanceof ApiError && (error.status === 412 || error.status === 428 || error.status === 0 || error.code === 'ETAG_INVALID' || error.code === 'RESPONSE_INVALID');
}
function hoursProblems(rows: HourRow[]): string[] {
  const segments: Array<{ start: number; end: number; row: number }> = [];
  const problems: string[] = [];
  const week = 7 * 1440;
  rows.forEach(({ interval }, index) => {
    if (!/^\d{2}:\d{2}$/.test(interval.opens_at_local) || !/^\d{2}:\d{2}$/.test(interval.closes_at_local)) {
      problems.push(`第 ${index + 1} 段：请填写开始和结束时间。`);
      return;
    }
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = (interval.weekday - 1) * 1440 + minutes(interval.opens_at_local);
    const end = (interval.weekday - 1 + interval.closes_day_offset) * 1440 + minutes(interval.closes_at_local);
    if (end <= start || end - start > 1440) {
      problems.push(`第 ${index + 1} 段：单段必须大于 0 且不超过 24 小时，请检查结束日期。`);
      return;
    }
    segments.push({ start, end: Math.min(end, week), row: index });
    if (end > week) segments.push({ start: 0, end: end - week, row: index });
  });
  segments.sort((a, b) => a.start - b.start);
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current.start < previous.end && current.row !== previous.row) {
      problems.push(`第 ${previous.row + 1} 段与第 ${current.row + 1} 段重叠（包含跨午夜与周界）。`);
    }
  }
  return problems;
}

export default function RestaurantWorkspace({ id, locales, busy, onBusyChange, onDirtyChange, onUpdated }: {
  id: string;
  locales: string[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onUpdated: (restaurant: Restaurant) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [rows, setRows] = useState<HourRow[]>([]);
  const [tab, setTab] = useState<'profile' | 'hours' | 'assets'>('profile');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [syncError, setSyncError] = useState<unknown>(null);
  const [conflicted, setConflicted] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const action = useAction(onBusyChange);
  const profileDirty = !!snapshot && !!draft && Object.keys(profilePatch(draft, snapshot.restaurant.data)).length > 0;
  const hoursDirty = !!snapshot && JSON.stringify(rows.map((row) => row.interval)) !== JSON.stringify(snapshot.hours.data.intervals);
  const dirty = profileDirty || hoursDirty;
  const problems = hoursProblems(rows);

  useEffect(() => {
    const controller = new AbortController();
    void readSnapshot(id, controller.signal).then((data) => {
      setSnapshot(data);
      setDraft(toProfileDraft(data.restaurant.data));
      setRows(toHourRows(data.hours.data.intervals));
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(error);
      setLoading(false);
    });
    return () => controller.abort();
  }, [id]);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function applySnapshot(data: Snapshot) {
    setSnapshot(data);
    setDraft(toProfileDraft(data.restaurant.data));
    setRows(toHourRows(data.hours.data.intervals));
    onUpdated(data.restaurant.data);
    setLoadError(null);
    setSyncError(null);
    setConflicted(false);
    setConfirmRefresh(false);
  }
  function refresh() {
    void action.run(async () => {
      applySnapshot(await readSnapshot(id));
      return '已重新读取服务端资料。请核对后再编辑和保存。';
    });
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !draft || !profileDirty || hoursDirty || conflicted || busy) return;
    const patch = profilePatch(draft, snapshot.restaurant.data);
    setSyncError(null);
    void action.run(async () => {
      let restaurant: Versioned<Restaurant>;
      try { restaurant = await api.updateRestaurant(id, patch, snapshot.restaurant.etag); }
      catch (error) { if (requiresRefresh(error)) setConflicted(true); throw error; }
      setSnapshot({ ...snapshot, restaurant });
      setDraft(toProfileDraft(restaurant.data));
      onUpdated(restaurant.data);
      try {
        const hours = await api.hours(id);
        if (hours.etag !== restaurant.etag) throw new ApiError(412, 'REVISION_CONFLICT');
        setSnapshot({ restaurant, hours });
        setRows(toHourRows(hours.data.intervals));
      } catch (error) {
        setConflicted(true);
        setSyncError(error);
        return '资料已保存，但共享版本尚未重新同步。请确认刷新后再继续编辑。';
      }
      return '餐厅资料已保存。仅更新草稿，不会发布网页或开放预订。';
    });
  }

  function saveHours(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !hoursDirty || profileDirty || conflicted || busy || !snapshot.restaurant.data.timezone || problems.length) return;
    setSyncError(null);
    void action.run(async () => {
      let hours: Versioned<OpeningHoursView>;
      try { hours = await api.updateHours(id, { intervals: rows.map((row) => ({ ...row.interval })) }, snapshot.hours.etag); }
      catch (error) { if (requiresRefresh(error)) setConflicted(true); throw error; }
      setSnapshot({ ...snapshot, hours });
      setRows(toHourRows(hours.data.intervals));
      try {
        // PUT 后重读餐厅，只有相同版本才能重新启用资料编辑。
        const restaurant = await api.restaurant(id);
        if (restaurant.etag !== hours.etag) throw new ApiError(412, 'REVISION_CONFLICT');
        setSnapshot({ restaurant, hours });
        setDraft(toProfileDraft(restaurant.data));
        onUpdated(restaurant.data);
      } catch (error) {
        setConflicted(true);
        setSyncError(error);
        return '营业时间已保存，但餐厅版本同步失败。请确认刷新后再继续编辑。';
      }
      return '周营业时间已保存，餐厅资料版本已同步。申请规则不代表可预订座位。';
    });
  }

  function changeRow(key: string, patch: Partial<OpeningInterval>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, interval: { ...row.interval, ...patch } } : row));
  }
  function addRow() {
    setRows((current) => current.length >= 21 ? current : [...current, {
      key: crypto.randomUUID(), interval: { weekday: 1, opens_at_local: '', closes_at_local: '', closes_day_offset: 0, accepts_requests: false, sort_order: current.length },
    }]);
  }

  if (loading) return <div className="workspace-loading" aria-busy="true" role="status"><p>正在读取餐厅资料与周营业时间…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  if (!snapshot || !draft) return <section><ErrorNotice error={loadError || action.error} /><button type="button" disabled={busy} onClick={refresh}>{action.pending ? '正在读取…' : '重新读取餐厅'}</button><ActionFeedback action={action} /></section>;
  const restaurant = snapshot.restaurant.data;
  const resting = weekdays.filter((_, index) => !rows.some((row) => row.interval.weekday === index + 1));
  const editable = restaurant.status === 'draft' || restaurant.status === 'active';
  const disabled = busy || action.pending || conflicted || !editable;

  return <section className="workspace" aria-label="餐厅管理">
    <header className="workspace-header">
      <div><p className="eyebrow">当前餐厅</p><h2>{restaurant.name}</h2><p className="micro">{statusLabels[restaurant.status]} · 版本 {restaurant.revision} · {restaurant.reservation_enabled ? '预约开关由后端管理' : '预订关闭'}</p></div>
      <button type="button" className="text-button" disabled={busy} onClick={() => { action.clear(); setConfirmRefresh(true); }}>刷新资料</button>
    </header>
    <div className="readiness">
      <p>仅资料检查。菜单与图片可保存原始素材，菜单编辑与发布未实现。</p>
      <p className="micro">{restaurant.readiness.missing_fields.length ? `待补充：${restaurant.readiness.missing_fields.map((field) => fieldLabels[field] ?? '其他资料').join('、')}` : '服务端检查暂无资料缺项；不代表可以发布。'}</p>
    </div>
    {!editable && <p className="notice">当前餐厅状态不可编辑。系统状态与归属不由此页面修改。</p>}
    {conflicted && <div className="notice" role="status"><p>版本发生冲突或写入结果需要核对。未保存内容仍保留，保存已暂停；请确认刷新，不会自动覆盖另一窗口。</p><button type="button" className="text-button" disabled={busy} onClick={() => setConfirmRefresh(true)}>查看刷新确认</button></div>}
    {confirmRefresh && <section className="notice confirmation" aria-labelledby="refresh-title">
      <h3 id="refresh-title">确认用服务端资料替换本页内容？</h3>
      <p>未保存的资料及营业时间将被丢弃。请先复制需要保留的内容；刷新后核对最新版本再编辑。</p>
      <div className="button-row"><button type="button" disabled={busy} onClick={refresh}>确认刷新并放弃未保存内容</button><button type="button" className="text-button" disabled={busy} onClick={() => setConfirmRefresh(false)}>继续留在本页</button></div>
    </section>}
    <ActionFeedback action={action} />
    <ErrorNotice error={syncError} />
    <div className="tab-nav" role="group" aria-label="资料分类">
      <button type="button" className={tab === 'profile' ? 'selected' : ''} aria-pressed={tab === 'profile'} disabled={busy} onClick={() => setTab('profile')}>餐厅资料{profileDirty ? ' · 未保存' : ''}</button>
      <button type="button" className={tab === 'hours' ? 'selected' : ''} aria-pressed={tab === 'hours'} disabled={busy} onClick={() => setTab('hours')}>周营业时间{hoursDirty ? ' · 未保存' : ''}</button>
      <button type="button" className={tab === 'assets' ? 'selected' : ''} aria-pressed={tab === 'assets'} disabled={busy} onClick={() => setTab('assets')}>菜单与图片</button>
    </div>
    <div hidden={tab !== 'assets'}><AssetsPanel key={id} restaurantId={id} busy={busy} onBusyChange={onBusyChange} /></div>
    {tab === 'profile' ? <form onSubmit={saveProfile} aria-busy={action.pending}>
      <p className="micro">名称与主要语言必填。其余字段可留空；清空已填写内容将以 null 保存。只提交发生变化的固定字段。</p>
      <fieldset disabled={disabled}>
        {(['basic', 'address', 'contact'] as const).map((group) => <section className="profile-group" key={group}>
          <h3>{group === 'basic' ? '基本信息' : group === 'address' ? '地址' : '联系与地区设置'}</h3>
          <div className="form-grid">{profileFields.filter((field) => field.group === group).map((field) => {
            const inputId = `profile-${field.key}`;
            const required = field.key === 'name' || field.key === 'primary_locale';
            return <div className={`field ${field.key === 'description' ? 'wide' : ''}`} key={field.key}>
              <label htmlFor={inputId}>{field.label}{!required && <span className="muted">（可选）</span>}</label>
              {field.key === 'description' ? <textarea id={inputId} value={draft[field.key]} maxLength={field.maxLength} rows={4} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
                : field.key === 'primary_locale' && locales.length > 0 ? <select id={inputId} value={draft.primary_locale} onChange={(event) => setDraft({ ...draft, primary_locale: event.target.value })} required>
                  {[...new Set([draft.primary_locale, ...locales])].map((locale) => <option key={locale} value={locale}>{locale === 'zh-CN' ? '简体中文' : locale === 'en' ? '英语' : locale}</option>)}
                </select> : <input id={inputId} type={field.type ?? 'text'} value={draft[field.key]} required={required} maxLength={field.maxLength} pattern={field.pattern} autoComplete="off" aria-describedby={field.hint ? `${inputId}-help` : undefined} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />}
              {field.hint && <p className="micro" id={`${inputId}-help`}>{field.hint}</p>}
            </div>;
          })}</div>
        </section>)}
        {hoursDirty && <p className="notice">营业时间还有未保存内容，请先保存或放弃营业时间，再保存资料。</p>}
        <div className="save-row"><button type="submit" className="primary-button" disabled={!profileDirty || hoursDirty}>保存餐厅资料</button><button type="button" className="text-button" disabled={!profileDirty} onClick={() => setDraft(toProfileDraft(restaurant))}>放弃资料修改</button><span className="micro">{profileDirty ? '有未保存修改' : '资料与已读取版本一致'}</span></div>
      </fieldset>
    </form> : tab === 'hours' ? <form onSubmit={saveHours} aria-busy={action.pending}>
      <p className="muted">按餐厅时区填写，每日可有多段。未配置的日期视为休息；保存会整体替换数组，最多 21 段。</p>
      <p className="micro">时区：{snapshot.hours.data.timezone ?? '尚未设置'}。单段大于 0 且不超过 24 小时，可跨至次日，不可重叠。</p>
      {!restaurant.timezone && <p className="notice">请先在餐厅资料中填写并保存有效时区，再保存营业时间。</p>}
      <fieldset disabled={disabled}>
        {rows.length === 0 && <div className="empty-state compact"><h3>尚未配置周营业时间</h3><p>当前所有日期休息。添加时段后填写真实营业规则，或保存空数组以清空。</p></div>}
        <div className="hour-rows">{rows.map((row, index) => <section className="hour-row" key={row.key} aria-label={`第 ${index + 1} 个营业时段`}>
          <div className="row-heading"><h3>时段 {index + 1}</h3><button type="button" className="text-button" aria-label={`删除第 ${index + 1} 个营业时段`} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>删除</button></div>
          <div className="hours-grid">
            <div className="field"><label htmlFor={`day-${row.key}`}>星期</label><select id={`day-${row.key}`} value={row.interval.weekday} onChange={(event) => changeRow(row.key, { weekday: Number(event.target.value) })}>{weekdays.map((day, dayIndex) => <option key={day} value={dayIndex + 1}>{day}</option>)}</select></div>
            <div className="field"><label htmlFor={`opens-${row.key}`}>开始时间</label><input id={`opens-${row.key}`} type="time" step={60} required value={row.interval.opens_at_local} onChange={(event) => changeRow(row.key, { opens_at_local: event.target.value })} /></div>
            <div className="field"><label htmlFor={`closes-${row.key}`}>结束时间</label><input id={`closes-${row.key}`} type="time" step={60} required value={row.interval.closes_at_local} onChange={(event) => changeRow(row.key, { closes_at_local: event.target.value })} /></div>
            <div className="field"><label htmlFor={`offset-${row.key}`}>结束日期</label><select id={`offset-${row.key}`} value={row.interval.closes_day_offset} onChange={(event) => changeRow(row.key, { closes_day_offset: Number(event.target.value) as 0 | 1 })}><option value={0}>当天</option><option value={1}>次日</option></select></div>
            <div className="field"><label htmlFor={`sort-${row.key}`}>排序</label><input id={`sort-${row.key}`} type="number" min={0} max={20} step={1} required value={row.interval.sort_order} onChange={(event) => changeRow(row.key, { sort_order: Number(event.target.value) })} /></div>
          </div>
          <label className="check-field" htmlFor={`accepts-${row.key}`}><input id={`accepts-${row.key}`} type="checkbox" checked={row.interval.accepts_requests} onChange={(event) => changeRow(row.key, { accepts_requests: event.target.checked })} /><span>此段允许申请（仅保存规则，不开放预订）</span></label>
        </section>)}</div>
        <button type="button" disabled={rows.length >= 21} onClick={addRow}>添加营业时段</button>
        <p className="micro" aria-live="polite">{rows.length} / 21 段{resting.length ? ` · 休息：${resting.join('、')}` : ' · 每日均有时段'}</p>
        {hoursDirty && problems.length > 0 && <div className="notice" aria-live="polite"><ul>{problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></div>}
        {profileDirty && <p className="notice">餐厅资料还有未保存内容，请先保存或放弃资料，再保存营业时间。</p>}
        <div className="save-row"><button type="submit" className="primary-button" disabled={!hoursDirty || profileDirty || !restaurant.timezone || problems.length > 0}>保存周营业时间</button><button type="button" className="text-button" disabled={!hoursDirty} onClick={() => setRows(toHourRows(snapshot.hours.data.intervals))}>放弃营业修改</button></div>
      </fieldset>
    </form> : null}
  </section>;
}
