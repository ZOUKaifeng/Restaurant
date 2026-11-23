import type { WebsiteEditableContent } from './website-types';
import type { RestaurantProfile } from './types';

export type WebsiteContentDraft = Pick<WebsiteEditableContent, 'restaurant' | 'opening_hours'> & { menu: WebsiteEditableContent['menu']['data'] };
export function contentDraft(content: WebsiteEditableContent): WebsiteContentDraft {
  return structuredClone({ restaurant: content.restaurant, opening_hours: content.opening_hours, menu: content.menu.data });
}
const fields: Array<[keyof RestaurantProfile, string, number]> = [
  ['name', 'Restaurant name', 150], ['description', 'Description', 2000], ['cuisine_label', 'Cuisine', 100],
  ['address_line1', 'Address', 200], ['address_line2', 'Address line 2', 200], ['city', 'City', 100],
  ['region', 'Region', 100], ['postal_code', 'Postal code', 32], ['country_code', 'Country code', 2],
  ['phone', 'Phone (international format)', 16], ['contact_email', 'Email', 254], ['timezone', 'Time zone', 64],
  ['currency_code', 'Currency code', 3],
];
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export default function WebsiteContentPanel({ draft, onChange, disabled, menuReview, onMenuReview, menuNeedsReview, onSave, onDiscard, dirty, saving, discardDisabled = false }: {
  draft: WebsiteContentDraft; onChange: (draft: WebsiteContentDraft) => void; disabled: boolean;
  menuReview: boolean; onMenuReview: (value: boolean) => void; menuNeedsReview: boolean;
  onSave: () => void; onDiscard: () => void; dirty: boolean; saving: boolean; discardDisabled?: boolean;
}) {
  const count = draft.menu.categories.reduce((sum, category) => sum + category.items.length, 0);
  const change = (run: (next: WebsiteContentDraft) => void) => { if (disabled) return; const next = structuredClone(draft); run(next); onChange(next); };
  return <form className="wb-content" onSubmit={event => { event.preventDefault(); if (!disabled && (!menuNeedsReview || menuReview)) onSave(); }} aria-busy={saving}>
    <p className="wb-small">Edit saved restaurant facts. Save & preview updates the same restaurant and menu, without AI or automatic publication.</p>
    <fieldset disabled={disabled}>
      <details className="wb-section wb-content-group"><summary><strong>Restaurant</strong><span>{draft.restaurant.name || 'Name required'} · {[draft.restaurant.city, draft.restaurant.cuisine_label].filter(Boolean).join(' · ') || 'Edit profile, address & contact'}</span></summary><div className="wb-fields">{fields.map(([key, label, max]) => <label key={key} className={key === 'description' ? 'wb-wide' : ''}>{label}
        {key === 'description' ? <textarea id={`wb-${key}`} rows={3} maxLength={max} value={draft.restaurant[key] ?? ''} onChange={event => change(next => { next.restaurant[key] = event.target.value || null; })} />
          : <input id={`wb-${key}`} type={key === 'contact_email' ? 'email' : 'text'} required={key === 'name'} maxLength={max} value={draft.restaurant[key] ?? ''} onChange={event => change(next => { const value = event.target.value; if (key === 'name') next.restaurant.name = value; else if (key === 'primary_locale') next.restaurant.primary_locale = value; else next.restaurant[key] = value || null; })} />}
      </label>)}<label>Language<select id="wb-primary_locale" value={draft.restaurant.primary_locale} onChange={event => change(next => { next.restaurant.primary_locale = event.target.value; })}><option value="en">English</option><option value="zh-CN">Chinese</option></select></label></div></details>
      <details className="wb-section wb-content-group"><summary><strong>Opening hours</strong><span>{draft.opening_hours.length} saved time segments · {draft.restaurant.timezone || 'Time zone not set'}</span></summary><p className="wb-small">Local restaurant time. Unlisted days are closed. Reservation rules are preserved.</p>
        {draft.opening_hours.map((hour, index) => <div className="wb-hours" key={index}>
          <label>Day<select aria-label={`Day ${index + 1}`} value={hour.weekday} onChange={event => change(next => { next.opening_hours[index].weekday = Number(event.target.value); })}>{weekdays.map((day, i) => <option key={day} value={i + 1}>{day}</option>)}</select></label>
          <label>Opens<input id={`wb-opens-${index}`} type="time" required value={hour.opens_at_local} onChange={event => change(next => { next.opening_hours[index].opens_at_local = event.target.value; })} /></label>
          <label>Closes<input id={`wb-closes-${index}`} type="time" required value={hour.closes_at_local} onChange={event => change(next => { next.opening_hours[index].closes_at_local = event.target.value; })} /></label>
          <label>End day<select value={hour.closes_day_offset} onChange={event => change(next => { next.opening_hours[index].closes_day_offset = Number(event.target.value) as 0 | 1; })}><option value={0}>Same day</option><option value={1}>Next day</option></select></label>
          <button type="button" aria-label={`Remove hours ${index + 1}`} onClick={() => change(next => { next.opening_hours.splice(index, 1); })}>Remove</button>
        </div>)}
        <button type="button" disabled={draft.opening_hours.length >= 21} onClick={() => change(next => {
          const used = new Set(next.opening_hours.map(hour => hour.sort_order));
          const order = Array.from({ length: 21 }, (_, i) => i).find(i => !used.has(i))!;
          next.opening_hours.push({ weekday: 1, opens_at_local: '09:00', closes_at_local: '17:00', closes_day_offset: 0, accepts_requests: false, sort_order: order });
        })}>Add hours</button>
      </details>
      <section className="wb-section"><h3>Menu <span className="wb-small">{count} / 80 items · Click a category to edit</span></h3>
        {draft.menu.warnings.length > 0 && <details><summary>Menu review warnings</summary><ul>{draft.menu.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        {draft.menu.categories.map((category, c) => <details className="wb-menu-category wb-content-group" key={c}><summary><strong>{category.name || 'New category'}</strong><span>{category.items.length} items · {category.items.slice(0, 3).map(item => item.name || 'New item').join(', ')}{category.items.length > 3 ? '…' : ''}</span></summary>
          <label>Category<input id={`wb-category-${c}`} required maxLength={150} value={category.name} onChange={event => change(next => { next.menu.categories[c].name = event.target.value; })} /></label>
          {category.items.map((item, i) => <details className="wb-menu-item" key={i}><summary>{item.name || 'New item'}<span>{item.price_text || 'No price'}{item.review_note ? ' · Review note' : ''}</span></summary><div className="wb-fields"><label>Item name<input id={`wb-item-${c}-${i}`} required maxLength={200} value={item.name} onChange={event => change(next => { next.menu.categories[c].items[i].name = event.target.value; })} /></label>
            <label>Price<input id={`wb-price-${c}-${i}`} maxLength={80} value={item.price_text ?? ''} onChange={event => change(next => { next.menu.categories[c].items[i].price_text = event.target.value || null; })} /></label>
            <label className="wb-wide">Description<textarea rows={2} maxLength={1000} value={item.description ?? ''} onChange={event => change(next => { next.menu.categories[c].items[i].description = event.target.value || null; })} /></label></div>
            {item.review_note && <p className="wb-small">Review note: {item.review_note}</p>}
            <button type="button" disabled={count <= 1} onClick={() => change(next => { next.menu.categories[c].items.splice(i, 1); if (!next.menu.categories[c].items.length) next.menu.categories.splice(c, 1); })}>Remove item</button>
          </details>)}
          <button type="button" disabled={count >= 80} onClick={() => change(next => { next.menu.categories[c].items.push({ name: '', description: null, price_text: null, review_note: null }); })}>Add item</button>
          <button type="button" disabled={category.items.length === count} onClick={() => change(next => { next.menu.categories.splice(c, 1); })}>Remove category</button>
        </details>)}
        <button type="button" disabled={count >= 80 || draft.menu.categories.length >= 20} onClick={() => change(next => { next.menu.categories.push({ name: '', items: [{ name: '', description: null, price_text: null, review_note: null }] }); })}>Add category</button>
        {menuNeedsReview && <label className="wb-check"><input type="checkbox" checked={menuReview} onChange={event => onMenuReview(event.target.checked)} />I have checked this menu and its prices for this save.</label>}
      </section>
    </fieldset>
    <div className="wb-save"><button type="submit" className="primary-button" disabled={disabled || (menuNeedsReview && !menuReview)}>{saving ? 'Saving…' : 'Save & preview'}</button><button type="button" disabled={!dirty || saving || discardDisabled} onClick={onDiscard}>Discard changes</button><span className="wb-small">{dirty ? 'Unsaved changes' : 'Saved restaurant content'}</span></div>
  </form>;
}
