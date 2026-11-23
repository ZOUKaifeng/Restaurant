import { PageLink } from './ui';
import { EXAMPLES_NOTICE, ExampleCardGrid, useExamplePreview } from './restaurant-examples';
import type { MarketingPageProps } from './restaurant-examples';
import './marketing.css';
import './example-designs.css';

export default function ExamplesPage({ navigate, busy, authenticated }: MarketingPageProps) {
  const { openExample, previewDialog } = useExamplePreview();
  const startPath = authenticated ? '/app' : '/auth/register';

  return <div className="tf-marketing tf-examples-page" lang="en">
    <section className="tf-examples-intro" aria-labelledby="tf-examples-page-title">
      <p className="tf-eyebrow">The Table Folk lookbook</p>
      <div className="tf-section-heading"><h1 id="tf-examples-page-title" tabIndex={-1}>A different table.{' '}<br />A different point of view.</h1><div className="tf-section-aside"><p>Four fictional restaurants. Four genuinely different websites — in layout, typography, photography, and rhythm. Find a feeling, not a fixed template.</p><p>Open a website to see its menu, story, and mobile layout.</p></div></div>
    </section>
    <section className="tf-lookbook" aria-labelledby="tf-lookbook-title"><div className="tf-lookbook-heading"><h2 id="tf-lookbook-title">Four restaurants. Four design directions.</h2><span>Illustrative website collection / 01</span></div><ExampleCardGrid openExample={openExample} /><div className="tf-examples-note"><p>Fictional restaurants and sample menus. AI-generated color photography.</p><p>{EXAMPLES_NOTICE}</p></div></section>
    <section className="tf-example-details" aria-labelledby="tf-example-details-title"><div><p className="tf-eyebrow">Look a little closer</p><h2 id="tf-example-details-title">The feeling changes.<br />The essentials stay.</h2></div><dl><div><dt>A menu you can explore</dt><dd>Illustrative dishes, descriptions, and prices, laid out for easy reading.</dd></div><div><dt>A little of your atmosphere</dt><dd>Color photography, space for a story, and a clear path to visit details.</dd></div><div><dt>A view for every screen</dt><dd>Switch between desktop and mobile inside the preview. The request form is example-only; no reservation is submitted.</dd></div></dl></section>
    <section className="tf-closing" aria-labelledby="tf-examples-closing-title"><div><p className="tf-eyebrow">Now make room for your restaurant</p><h2 id="tf-examples-closing-title">Your place.<br />Your point of view.</h2><p>Start with your menu, photos, and ideas.</p></div><PageLink className="tf-button tf-button-primary" href={startPath} navigate={navigate} disabled={busy}>Create your website <span aria-hidden="true">↗</span></PageLink></section>
    {previewDialog}
  </div>;
}
