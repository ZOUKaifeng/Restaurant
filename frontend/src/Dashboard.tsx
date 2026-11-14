import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api';
import RestaurantWorkspace from './RestaurantWorkspace';
import type { CurrentUser, Restaurant, RestaurantCreateInput, RestaurantList } from './types';
import { ActionFeedback, ErrorNotice, LocaleSelect, useAction } from './ui';

interface CreateAttempt { key: string; body: RestaurantCreateInput }
function CreateRestaurant({ locales, busy, onBusyChange, onCreated }: {
  locales: string[]; busy: boolean; onBusyChange: (busy: boolean) => void; onCreated: (restaurant: Restaurant) => void;
}) {
  const attempt = useRef<CreateAttempt | null>(null);
  const [hasAttempt, setHasAttempt] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const action = useAction(onBusyChange);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || action.pending) return;
    const form = event.currentTarget;
    if (!attempt.current) {
      const values = new FormData(form);
      attempt.current = {
        key: crypto.randomUUID(),
        body: { name: String(values.get('name') ?? '').trim(), primary_locale: String(values.get('primary_locale') ?? '') },
      };
      setHasAttempt(true);
    }
    const request = attempt.current;
    void action.run(async () => {
      const { data } = await api.createRestaurant(request.body, request.key);
      attempt.current = null;
      setHasAttempt(false);
      form.reset();
      onCreated(data);
    });
  }
  function newRequest() {
    attempt.current = null;
    setHasAttempt(false);
    setConfirmNew(false);
    action.clear();
  }
  return <section className="create-panel">
    <p className="eyebrow">餐厅 / 创建</p><h2>创建餐厅草稿</h2>
    <p className="muted">只需名称与主要语言。新店预订关闭，其他资料可随后补充。</p>
    <form onSubmit={submit} aria-busy={action.pending}>
      <fieldset disabled={busy || action.pending}>
        <div className="form-grid">
          <div className="field"><label htmlFor="create-name">餐厅名称</label><input id="create-name" name="name" required maxLength={150} readOnly={hasAttempt} autoComplete="organization" /></div>
          <div className="field"><label htmlFor="create-locale">餐厅主要语言</label>
            {hasAttempt ? <><input id="create-locale" value={attempt.current?.body.primary_locale ?? ''} readOnly /><input type="hidden" name="primary_locale" value={attempt.current?.body.primary_locale ?? ''} /></>
              : locales.length > 0 ? <LocaleSelect id="create-locale" name="primary_locale" locales={locales} />
              : <input id="create-locale" name="primary_locale" defaultValue="zh-CN" required minLength={2} maxLength={35} pattern="[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*" />}
          </div>
        </div>
        <button type="submit" className="primary-button">{action.pending ? '正在创建…' : hasAttempt ? '重试同一创建请求' : '创建餐厅草稿'}</button>
      </fieldset>
    </form>
    <ActionFeedback action={action} />
    {hasAttempt && !action.pending && <div className="notice">
      <p>本次请求的内容和幂等键仍在内存中。重试不会换键；离开或刷新会丢失它。请求超时不表示创建失败，请先核对左侧列表。</p>
      <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmNew(true)}>开始新的创建请求</button>
    </div>}
    {confirmNew && <section className="notice" aria-labelledby="new-request-title"><h3 id="new-request-title">确认已核对餐厅列表？</h3><p>旧请求可能已经创建餐厅。换新键再次提交可能创建另一家店，不能用于重试同一次请求。</p><div className="button-row"><button type="button" disabled={busy} onClick={newRequest}>已核对，放弃旧请求并换新键</button><button type="button" className="text-button" disabled={busy} onClick={() => setConfirmNew(false)}>保留原请求</button></div></section>}
  </section>;
}

export default function Dashboard({ user, locales, busy, onBusyChange }: {
  user: CurrentUser; locales: string[]; busy: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [list, setList] = useState<RestaurantList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [nextSelection, setNextSelection] = useState<string | 'create' | null>(null);
  const [notice, setNotice] = useState('');
  const listAction = useAction(onBusyChange);
  useEffect(() => {
    const controller = new AbortController();
    void api.restaurants(undefined, controller.signal).then((data) => {
      setList(data);
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(error);
      setLoading(false);
    });
    return () => controller.abort();
  }, [user.id]);

  function loadList(more = false) {
    if (busy || listAction.pending) return;
    void listAction.run(async () => {
      const data = await api.restaurants(more && list?.next_cursor ? list.next_cursor : undefined);
      setList((current) => more && current ? {
        ...data, items: [...current.items, ...data.items.filter((item) => !current.items.some((existing) => existing.id === item.id))],
      } : data);
      setLoadError(null);
    });
  }
  function applySelection(value: string) {
    setCreating(value === 'create');
    setSelected(value === 'create' ? null : value);
    setNextSelection(null);
    setDirty(false);
    setNotice('');
  }
  function choose(value: string) {
    if (busy || (selected === value && !creating) || (value === 'create' && creating)) return;
    if (dirty) setNextSelection(value);
    else applySelection(value);
  }
  function updated(restaurant: Restaurant) {
    setList((current) => current ? { ...current, items: current.items.map((item) => item.id === restaurant.id ? restaurant : item) } : current);
  }
  function created(restaurant: Restaurant) {
    setList((current) => current ? { ...current, items: [restaurant, ...current.items.filter((item) => item.id !== restaurant.id)] } : { items: [restaurant], next_cursor: null, has_more: false });
    setCreating(false);
    setSelected(restaurant.id);
    setDirty(false);
    setNotice('餐厅草稿已创建或恢复同一幂等请求的结果。预订仍关闭，请补充资料。');
  }

  return <section className="dashboard">
    <header className="dashboard-intro"><p className="eyebrow">商家工作台</p><h1 tabIndex={-1}>餐厅资料</h1><p className="muted">管理自己的餐厅草稿与周营业规则。</p></header>
    <div className="dashboard-grid">
      <aside className="restaurant-sidebar" aria-label="本人餐厅列表">
        <div className="sidebar-heading"><h2>我的餐厅</h2><button type="button" className="text-button" disabled={busy || loading} onClick={() => loadList()}>刷新列表</button></div>
        {loading && <div role="status" aria-busy="true"><p className="micro">正在读取餐厅…</p><div className="skeleton-line" /><div className="skeleton-line short" /></div>}
        <ErrorNotice error={loadError} />
        {Boolean(loadError) && <button type="button" disabled={busy} onClick={() => loadList()}>重试读取列表</button>}
        <ActionFeedback action={listAction} />
        {list?.items.length === 0 && <p className="muted sidebar-empty">还没有餐厅。创建第一份真实草稿，从名称开始。</p>}
        {list && <ul className="restaurant-list">{list.items.map((restaurant) => <li key={restaurant.id}><button type="button" className={selected === restaurant.id ? 'restaurant-option selected' : 'restaurant-option'} aria-pressed={selected === restaurant.id} disabled={busy} onClick={() => choose(restaurant.id)}><span>{restaurant.name}</span><span className="micro">{restaurant.status === 'draft' ? '草稿' : restaurant.status === 'active' ? '已启用' : restaurant.status === 'suspended' ? '已暂停' : '已归档'} · {restaurant.reservation_enabled ? '预约开关由后端管理' : '预订关闭'}</span></button></li>)}</ul>}
        {list?.has_more && list.next_cursor && <button type="button" className="text-button" disabled={busy} onClick={() => loadList(true)}>读取更多餐厅</button>}
        <button type="button" className="create-entry" disabled={busy || loading || !list} onClick={() => choose('create')}>创建餐厅草稿</button>
      </aside>
      <div className="dashboard-content">
        {nextSelection && <section className="notice" aria-labelledby="switch-title"><h3 id="switch-title">放弃未保存内容并切换？</h3><p>当前餐厅有未保存的修改。切换不会保存这些内容。</p><div className="button-row"><button type="button" disabled={busy} onClick={() => applySelection(nextSelection)}>确认放弃并切换</button><button type="button" className="text-button" disabled={busy} onClick={() => setNextSelection(null)}>返回继续编辑</button></div></section>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div hidden={!creating}><CreateRestaurant locales={locales} busy={busy} onBusyChange={onBusyChange} onCreated={created} /></div>
        {!creating && (selected ? <RestaurantWorkspace key={selected} id={selected} locales={locales} busy={busy} onBusyChange={onBusyChange} onDirtyChange={setDirty} onUpdated={updated} />
          : <div className="empty-state"><p className="eyebrow">餐厅工作区</p><h2>{loading ? '等待读取餐厅' : '选择一家餐厅，或从草稿开始'}</h2><p>这里只显示当前账户的真实资料。没有示例店铺，也没有模拟经营数据。</p></div>)}
      </div>
    </div>
  </section>;
}
