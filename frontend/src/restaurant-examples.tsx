import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject, ReactNode } from 'react';
import type { Navigate } from './ui';

export type MarketingPageProps = { navigate: Navigate; busy: boolean; authenticated: boolean };
type ExamplePhoto = { src: string; alt: string; width: number; height: number };
export type RestaurantExample = {
  id: 'marlow' | 'forma' | 'june' | 'miso';
  name: string; category: string; style: string;
  theme: 'editorial' | 'modern' | 'supper' | 'quiet';
  layout: 'split-editorial' | 'poster-diner' | 'immersive-night' | 'quiet-rail';
  designNote: string; eyebrow: string; headline: readonly string[]; description: string;
  menuTitle: string; storyTitle: string; story: string; hours: string;
  photo: ExamplePhoto; storyPhoto: ExamplePhoto;
  menu: readonly { name: string; detail: string; price: string }[];
};
const photo = (name: string, alt: string): ExamplePhoto => ({ src: `/brand/${name}`, alt: `AI-generated color photograph: ${alt}`, width: 1264, height: 848 });
const tablePhoto = photo('table-editorial.jpg', 'seasonal plates on a sunlit linen-covered table.');
const roomPhoto = photo('bistro-interior.jpg', 'a light-filled bistro with wooden chairs and green paneling.');
const dinerPhoto = photo('forma-diner.jpg', 'crispy chicken sandwiches and fries on orange diner trays.');
const supperPhoto = photo('june-supper.jpg', 'an intimate candlelit dining room with walnut tables.');
const misoPhoto = photo('miso-table.jpg', 'a Japanese salmon set meal with rice, soup, and pickles.');

export const RESTAURANT_EXAMPLES: readonly RestaurantExample[] = [
  {
    id: 'marlow', name: 'Marlow & Pine', category: 'Neighborhood bistro', style: 'An editorial afternoon',
    theme: 'editorial', layout: 'split-editorial',
    designNote: 'Serif typography, a split opening, generous margins, and a magazine-style story.',
    eyebrow: 'A neighborhood table.', headline: ['Good food.', 'Good company.'],
    description: 'Seasonal plates. Familiar faces. A little room to slow down.',
    menuTitle: 'Something for the table.', storyTitle: 'Come as you are.',
    story: 'A corner of the neighborhood for long lunches, shared plates, and one more conversation. Simple food, thoughtfully made.',
    hours: 'Tuesday–Sunday · 5–10 pm', photo: tablePhoto, storyPhoto: roomPhoto,
    menu: [
      { name: 'Warm sourdough', detail: 'Cultured butter, flaky sea salt', price: '$8' },
      { name: 'Garden greens', detail: 'Tender leaves, lemon vinaigrette', price: '$12' },
      { name: 'Roasted vegetables', detail: 'Seasonal roots, herbs, yogurt', price: '$14' },
      { name: 'Grilled market fish', detail: 'Lemon, olive oil, fresh herbs', price: '$28' },
    ],
  },
  {
    id: 'forma', name: 'Forma', category: 'All-day diner', style: 'Loud, sunny & graphic',
    theme: 'modern', layout: 'poster-diner',
    designNote: 'An oversized wordmark, tomato-orange poster layout, playful image tiles, and a diner menu board.',
    eyebrow: 'Good mornings. Better lunch breaks.', headline: ['BIG ON', 'GOOD TIMES.'],
    description: 'Coffee first. Something crispy next. All-day good company.',
    menuTitle: 'THE GOOD STUFF.', storyTitle: 'YOUR NEW USUAL.',
    story: 'The first coffee, the long lunch, the extra side of fries. We made a place for the everyday things worth looking forward to.',
    hours: 'Monday–Sunday · 8 am–9 pm', photo: dinerPhoto, storyPhoto: roomPhoto,
    menu: [
      { name: 'Breakfast toast', detail: 'Soft egg, sourdough, chili crunch', price: '$14' },
      { name: 'Crispy chicken bun', detail: 'House slaw, pickles, sesame bun', price: '$18' },
      { name: 'Golden fries', detail: 'Sea salt, house dipping sauce', price: '$7' },
      { name: 'House iced coffee', detail: 'Cold brew, oat milk optional', price: '$6' },
    ],
  },
  {
    id: 'june', name: 'June Supper House', category: 'Intimate evening dining', style: 'After dark, cinematic',
    theme: 'supper', layout: 'immersive-night',
    designNote: 'Full-bleed evening photography, an overlaid navigation, centered type, and a tasting-menu rhythm.',
    eyebrow: 'Dinner. Slowly.', headline: ['An evening', 'to remember.'],
    description: 'The lights are low. The table is yours. Stay a little longer.',
    menuTitle: 'An evening in four moments.', storyTitle: 'Leave the hurry at the door.',
    story: 'Candlelight, a generous table, and the kind of conversation that goes on long after dessert. An unhurried evening, made one course at a time.',
    hours: 'Wednesday–Sunday · 5–11 pm', photo: supperPhoto, storyPhoto: supperPhoto,
    menu: [
      { name: 'Burrata & stone fruit', detail: 'Basil, aged balsamic, toasted bread', price: '$17' },
      { name: 'Roasted mushrooms', detail: 'Brown butter, thyme, crisp shallots', price: '$16' },
      { name: 'Fish for two', detail: 'Market fish, seasonal sides, lemon', price: '$54' },
      { name: 'Olive oil cake', detail: 'Soft cream, berries', price: '$11' },
    ],
  },
  {
    id: 'miso', name: 'Miso Room', category: 'Japanese neighborhood kitchen', style: 'Quiet, precise & minimal',
    theme: 'quiet', layout: 'quiet-rail',
    designNote: 'A slim side navigation, restrained typography, an asymmetric photo composition, and a precise one-column menu.',
    eyebrow: 'A little space in your day.', headline: ['Simply made.', 'Quietly enjoyed.'],
    description: 'Rice. Soup. Something seasonal. A daily ritual, thoughtfully made.',
    menuTitle: 'The daily table.', storyTitle: 'Less, with care.',
    story: 'A warm bowl, a familiar seat, a few good ingredients. Our kitchen takes its time with the small things. We hope you will, too.',
    hours: 'Tuesday–Sunday · 11 am–8 pm', photo: misoPhoto, storyPhoto: misoPhoto,
    menu: [
      { name: 'Miso salmon set', detail: 'Rice, soup, seasonal pickles', price: '$24' },
      { name: 'Roasted mushroom rice', detail: 'Dashi, scallion, toasted sesame', price: '$19' },
      { name: 'Seasonal greens', detail: 'Sesame dressing, crisp vegetables', price: '$9' },
      { name: 'Hojicha', detail: 'Warm roasted Japanese tea', price: '$5' },
    ],
  },
];
export const EXAMPLES_NOTICE = 'Illustrative examples. Product rollout in progress. Not live restaurant websites.';

export function RestaurantCover({ example, mobile = false, eager = false }: {
  example: RestaurantExample; mobile?: boolean; eager?: boolean;
}) {
  const image = <img {...example.photo} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />;
  const headline = example.headline.map((line) => <span key={line}>{line}</span>);
  let design: ReactNode;
  if (example.theme === 'modern') {
    design = <><span className="tf-cover-diner-nav"><span>COFFEE / LUNCH / ALL DAY</span><span>MENU ↗</span></span><span className="tf-cover-diner-brand">FORMA<span>↗</span></span><span className="tf-cover-diner-tiles"><span className="tf-cover-diner-poster"><span className="tf-cover-headline">{headline}</span><span className="tf-cover-diner-stamp">COME<br />HUNGRY.</span></span><span className="tf-cover-diner-photo">{image}</span></span><span className="tf-cover-diner-foot">A LITTLE EXTRA GOOD IN YOUR EVERYDAY.</span></>;
  } else if (example.theme === 'supper') {
    design = <><span className="tf-cover-night-photo">{image}</span><span className="tf-cover-night-shade" /><span className="tf-cover-night-nav"><span>JUNE</span><span>SUPPER / VISIT / RESERVE</span></span><span className="tf-cover-night-title"><span className="tf-cover-eyebrow">DINNER. SLOWLY.</span><span className="tf-cover-headline">{headline}</span><span className="tf-cover-night-cta">A TABLE FOR THE EVENING ↗</span></span><span className="tf-cover-night-foot">June Supper House <span>AN EVENING WELL SPENT</span></span></>;
  } else if (example.theme === 'quiet') {
    design = <><span className="tf-cover-quiet-rail"><span>MISO<br />ROOM</span><span>MENU<br /><br />STORY<br /><br />VISIT</span><span>01 — 04</span></span><span className="tf-cover-quiet-main"><span className="tf-cover-quiet-top">A NEIGHBORHOOD KITCHEN</span><span className="tf-cover-headline">{headline}</span><span className="tf-cover-quiet-photo">{image}</span><span className="tf-cover-quiet-foot">The daily table. <span>MENU ↗</span></span></span></>;
  } else {
    design = <><span className="tf-cover-nav"><span className="tf-cover-brand">{example.name}</span><span className="tf-cover-nav-links">Menu <span>Visit</span></span><span className="tf-cover-mobile-menu">Menu</span></span><span className="tf-cover-content"><span className="tf-cover-copy"><span className="tf-cover-eyebrow">{example.eyebrow}</span><span className="tf-cover-headline">{headline}</span><span className="tf-cover-description">{example.description}</span></span><span className="tf-cover-photo">{image}</span></span><span className="tf-cover-bottom"><span>{example.menuTitle}</span><span>Seasonal & shared</span></span></>;
  }
  return <span className="tf-cover" data-theme={example.theme} data-design={example.layout} data-mobile={mobile || undefined} aria-hidden="true">{design}</span>;
}

export function ExampleCardGrid({ openExample, interactive = true }: {
  openExample?: (example: RestaurantExample, trigger: HTMLButtonElement) => void;
  interactive?: boolean;
}) {
  return <div className="tf-example-grid">{RESTAURANT_EXAMPLES.map((example, index) => <article className="tf-example-card" key={example.id}>
    {interactive && openExample
      ? <button className="tf-example-trigger" type="button" aria-haspopup="dialog" aria-label={`Open ${example.name}, ${example.style.toLowerCase()} website example`} onClick={(event) => openExample(example, event.currentTarget)}><RestaurantCover example={example} /><span className="tf-example-hover">Open full example <span aria-hidden="true">↗</span></span></button>
      : <div className="tf-example-static"><RestaurantCover example={example} /></div>}
    <div className="tf-card-caption"><div><h3>{example.name}</h3><p>{example.category} · {example.style}</p></div><span className="tf-card-index" aria-hidden="true">0{index + 1}</span></div><p className="tf-card-design-note">{example.designNote}</p>
  </article>)}</div>;
}

type SectionRefs = { menu: RefObject<HTMLElement | null>; story: RefObject<HTMLElement | null>; visit: RefObject<HTMLElement | null>; booking: RefObject<HTMLElement | null> };
function ExampleHeader({ example, refs, rail = false }: { example: RestaurantExample; refs: SectionRefs; rail?: boolean }) {
  const mobileNav = useRef<HTMLDetailsElement>(null);
  const links = () => (['menu', 'story', 'visit', 'booking'] as const).map((key) => <button key={key} type="button" className={key === 'booking' ? 'tf-site-nav-cta' : undefined} onClick={() => { if (mobileNav.current) mobileNav.current.open = false; refs[key].current?.scrollIntoView({ block: 'start', behavior: 'auto' }); refs[key].current?.focus({ preventScroll: true }); }}>{key === 'menu' ? 'Menu' : key === 'story' ? 'Our story' : key === 'visit' ? 'Visit' : 'Request a table'}</button>);
  return <header className={`tf-site-header${rail ? ' tf-site-rail' : ''}`}><span className="tf-site-brand">{example.name}</span><nav className="tf-site-desktop-nav" aria-label={`${example.name} example navigation`}>{links()}</nav><details className="tf-site-mobile-nav" ref={mobileNav}><summary>Menu <span aria-hidden="true">+</span></summary><nav aria-label={`${example.name} mobile navigation`}>{links()}</nav></details>{rail && <span className="tf-rail-foot">A daily ritual.<br />Made with care.</span>}</header>;
}
function MenuSection({ example, prefix, refs }: { example: RestaurantExample; prefix: string; refs: SectionRefs }) {
  return <section className="tf-site-menu tf-site-section" id={`${prefix}-menu`} ref={refs.menu} tabIndex={-1} aria-labelledby={`${prefix}-menu-title`}><p className="tf-site-eyebrow">{example.theme === 'supper' ? 'The evening menu' : 'From our kitchen'}</p><h3 id={`${prefix}-menu-title`}>{example.menuTitle}</h3><p className="tf-site-note">Fictional dishes and prices. An example menu, not a real offer.</p><ul className="tf-site-dishes">{example.menu.map((dish, index) => <li key={dish.name}><span className="tf-course-number" aria-hidden="true">0{index + 1}</span><div><h4>{dish.name}</h4><p>{dish.detail}</p></div><span className="tf-dish-price">{dish.price}</span></li>)}</ul></section>;
}
function StorySection({ example, prefix, refs }: { example: RestaurantExample; prefix: string; refs: SectionRefs }) {
  return <section className="tf-site-story tf-site-section" id={`${prefix}-story`} ref={refs.story} tabIndex={-1} aria-labelledby={`${prefix}-story-title`}><img {...example.storyPhoto} loading="lazy" decoding="async" /><div><p className="tf-site-eyebrow">{example.theme === 'supper' ? 'An invitation' : 'Our kind of place'}</p><h3 id={`${prefix}-story-title`}>{example.storyTitle}</h3><p>{example.story}</p></div></section>;
}
function VisitSection({ example, prefix, refs }: { example: RestaurantExample; prefix: string; refs: SectionRefs }) {
  return <section className="tf-site-visit tf-site-section" id={`${prefix}-visit`} ref={refs.visit} tabIndex={-1} aria-labelledby={`${prefix}-visit-title`}><div><p className="tf-site-eyebrow">Find your way here</p><h3 id={`${prefix}-visit-title`}>{example.theme === 'modern' ? 'SEE YOU SOON.' : example.theme === 'quiet' ? 'A familiar place.' : 'Make yourself at home.'}</h3><p>{example.description}</p></div><dl><div><dt>Illustrative hours</dt><dd>{example.hours}</dd></div><div><dt>Location & contact</dt><dd>Fictional restaurant. Address and contact details are intentionally omitted.</dd></div></dl></section>;
}
function BookingSection({ prefix, refs }: { prefix: string; refs: SectionRefs }) {
  return <section className="tf-site-booking tf-site-section" id={`${prefix}-booking`} ref={refs.booking} tabIndex={-1} aria-labelledby={`${prefix}-booking-title`}><p className="tf-site-eyebrow">A seat at the table</p><h3 id={`${prefix}-booking-title`}>Plan your visit.</h3><p className="tf-site-note">A request is not a confirmed reservation. This example does not check availability.</p><form onSubmit={(event) => event.preventDefault()} aria-describedby={`${prefix}-booking-notice`}><div className="tf-site-booking-fields"><label htmlFor={`${prefix}-date`}>Date<input id={`${prefix}-date`} type="date" /></label><label htmlFor={`${prefix}-time`}>Time<select id={`${prefix}-time`} defaultValue="19:00"><option value="18:00">6:00 pm</option><option value="19:00">7:00 pm</option><option value="20:00">8:00 pm</option></select></label><label htmlFor={`${prefix}-party`}>Party size<select id={`${prefix}-party`} defaultValue="2">{[1, 2, 3, 4, 5, 6].map((size) => <option key={size} value={size}>{size} {size === 1 ? 'guest' : 'guests'}</option>)}</select></label></div><button className="tf-site-button" type="submit" disabled>Requests unavailable in example</button><p className="tf-site-booking-notice" id={`${prefix}-booking-notice`}>Example only — no reservation is submitted.</p></form></section>;
}

export function RestaurantWebsite({ example, mobile }: { example: RestaurantExample; mobile: boolean }) {
  const prefix = `tf-restaurant-${useId().replace(/:/g, '')}`;
  const refs: SectionRefs = { menu: useRef<HTMLElement>(null), story: useRef<HTMLElement>(null), visit: useRef<HTMLElement>(null), booking: useRef<HTMLElement>(null) };
  const jumpMenu = () => { refs.menu.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); refs.menu.current?.focus({ preventScroll: true }); };
  const title = <h2>{example.headline.map((line) => <span key={line}>{line}</span>)}</h2>;
  const menu = <MenuSection example={example} prefix={prefix} refs={refs} />;
  const story = <StorySection example={example} prefix={prefix} refs={refs} />;
  const visit = <VisitSection example={example} prefix={prefix} refs={refs} />;
  const booking = <BookingSection prefix={prefix} refs={refs} />;
  const footer = <footer className="tf-site-footer"><span className="tf-site-brand">{example.name}</span><p>Fictional restaurant · Illustrative website</p></footer>;
  let body: ReactNode;
  if (example.theme === 'modern') {
    body = <><ExampleHeader example={example} refs={refs} /><div className="tf-diner-masthead">FORMA<span>ALL DAY, EVERY DAY.</span></div><section className="tf-diner-opening"><div className="tf-diner-poster"><p className="tf-site-eyebrow">{example.eyebrow}</p>{title}<button className="tf-site-button" type="button" onClick={jumpMenu}>See the good stuff ↗</button><span className="tf-diner-seal" aria-hidden="true">COME<br />HUNGRY.</span></div><figure className="tf-diner-food"><img {...example.photo} loading="eager" decoding="async" /><figcaption>A LITTLE EXTRA GOOD.</figcaption></figure></section><div className="tf-diner-strip">COFFEE FIRST <span aria-hidden="true">/</span> BIG LUNCHES <span aria-hidden="true">/</span> ONE MORE SIDE OF FRIES</div>{menu}{visit}{story}{booking}{footer}</>;
  } else if (example.theme === 'supper') {
    body = <><section className="tf-night-opening"><img className="tf-night-image" {...example.photo} loading="eager" decoding="async" /><div className="tf-night-overlay" /><ExampleHeader example={example} refs={refs} /><div className="tf-night-copy"><p className="tf-site-eyebrow">{example.eyebrow}</p>{title}<p>{example.description}</p><button className="tf-site-button" type="button" onClick={() => { refs.booking.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); refs.booking.current?.focus({ preventScroll: true }); }}>A table for the evening ↗</button></div><div className="tf-night-bottom"><span>JUNE SUPPER HOUSE</span><button type="button" onClick={jumpMenu}>Explore the evening ↓</button></div></section>{story}{menu}<div className="tf-night-closing"><p>Good conversation.<br />A very good evening.</p></div>{booking}{visit}{footer}</>;
  } else if (example.theme === 'quiet') {
    body = <div className="tf-quiet-layout"><ExampleHeader example={example} refs={refs} rail /><div className="tf-quiet-content"><section className="tf-quiet-opening"><div className="tf-quiet-heading"><p className="tf-site-eyebrow">{example.eyebrow}</p>{title}<p>{example.description}</p></div><figure><img {...example.photo} loading="eager" decoding="async" /><figcaption>01 / THE DAILY TABLE</figcaption></figure><button className="tf-quiet-menu-link" type="button" onClick={jumpMenu}>Explore the menu <span aria-hidden="true">↗</span></button></section>{menu}{story}{visit}{booking}{footer}</div></div>;
  } else {
    body = <><ExampleHeader example={example} refs={refs} /><section className="tf-editorial-opening"><div><p className="tf-site-eyebrow">{example.eyebrow}</p>{title}<p className="tf-site-description">{example.description}</p><button className="tf-site-button" type="button" onClick={jumpMenu}>Explore the menu ↗</button></div><img {...example.photo} loading="eager" decoding="async" /></section>{menu}{story}{visit}{booking}{footer}</>;
  }
  return <article className={`tf-site${mobile ? ' tf-site-mobile' : ''}`} data-theme={example.theme} data-design={example.layout} aria-label={`${example.name} illustrative restaurant website`}>{body}</article>;
}

export function useExamplePreview() {
  const [selected, setSelected] = useState<RestaurantExample | null>(null);
  const [size, setSize] = useState<'desktop' | 'mobile'>('desktop');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const prefix = `tf-preview-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    if (selected && dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [selected, size]);
  function openExample(example: RestaurantExample, trigger: HTMLButtonElement) { triggerRef.current = trigger; setSize('desktop'); setSelected(example); }
  function close() { dialogRef.current?.close(); }
  function closed() { setSelected(null); if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true }); }
  const previewDialog = <dialog className="tf-preview-dialog" ref={dialogRef} aria-labelledby={`${prefix}-title`} aria-describedby={`${prefix}-notice`} onClose={closed} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }}>{selected && <><div className="tf-preview-toolbar"><div><p className="tf-preview-label">Website example / {selected.style}</p><h2 id={`${prefix}-title`}>{selected.name}</h2></div><div className="tf-preview-controls"><div className="tf-preview-sizes" role="group" aria-label="Example preview width"><button type="button" aria-pressed={size === 'desktop'} onClick={() => setSize('desktop')}>Desktop</button><button type="button" aria-pressed={size === 'mobile'} onClick={() => setSize('mobile')}>Mobile</button></div><button className="tf-preview-close" type="button" onClick={close} aria-label="Close restaurant website example" autoFocus><span aria-hidden="true">×</span></button></div></div><div className="tf-preview-scroll" ref={viewportRef}><p className="tf-preview-context">{size === 'mobile' ? 'Mobile layout · 375 px, or smaller to fit your screen' : 'Desktop layout · adapts to your screen'} <span>Fictional restaurant</span></p><RestaurantWebsite key={`${selected.id}-${size}`} example={selected} mobile={size === 'mobile'} /></div><p className="tf-preview-disclaimer" id={`${prefix}-notice`}>{EXAMPLES_NOTICE} No bookings or requests are submitted.</p></>}</dialog>;
  return { openExample, previewDialog };
}
