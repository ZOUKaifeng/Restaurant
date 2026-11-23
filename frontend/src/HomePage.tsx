import { useEffect, useRef } from 'react';
import { attachHomeMotion } from './home-motion';
import { PageLink } from './ui';
import { EXAMPLES_NOTICE, ExampleCardGrid, RESTAURANT_EXAMPLES, RestaurantCover } from './restaurant-examples';
import type { MarketingPageProps } from './restaurant-examples';
import './marketing.css';
import './example-designs.css';

const questions = [
  {
    question: 'What should I bring to the table?',
    answer: 'Your menu, basic restaurant details, and photos you have permission to use. An idea of the atmosphere helps, too. Start with what you have, then review the dishes, prices, and copy as you go.',
  },
  {
    question: 'What can I do with Table Folk today?',
    answer: 'Build and preview website drafts, work with menu content, and review guest requests where configured. Product rollout is in progress; the management experience is still being developed. A website draft is not a published public website.',
  },
  {
    question: 'Can I see how a website feels on a phone?',
    answer: 'Yes. Open an example and switch between Desktop and Mobile. The preview adapts to the available screen width, so you can explore its menu, story, and visit sections without leaving this page.',
  },
  {
    question: 'Who reviews the menu and prices?',
    answer: 'You do. Check extracted dishes, descriptions, and prices before confirming a menu. Review the website copy and layout, too. Your restaurant knowledge belongs in the process, not on the sidelines.',
  },
  {
    question: 'Does a table request guarantee a seat?',
    answer: 'No. A request is not a confirmed reservation, and opening hours are not seat inventory. The restaurant needs to review a real request and communicate its decision. The examples on this page never submit requests or check availability.',
  },
  {
    question: 'What about publishing, my domain, and emails?',
    answer: 'Public domains and email delivery are not configured in the current rollout. Building or previewing a draft does not automatically publish a public website, connect your domain, or send confirmation emails.',
  },
  {
    question: 'Are these real restaurant websites?',
    answer: `${EXAMPLES_NOTICE} The restaurant names, menus, and prices are fictional; the color photography is AI-generated. They show design possibilities, not customers or finished product deployments.`,
  },
];

export default function HomePage({ navigate, busy, authenticated }: MarketingPageProps) {
  const featured = RESTAURANT_EXAMPLES[0];
  const startPath = authenticated ? '/app' : '/auth/register';
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pageRef.current) return attachHomeMotion(pageRef.current);
  }, []);

  return <div className="tf-marketing tf-home" lang="en" ref={pageRef}>
    <section className="tf-hero" aria-labelledby="tf-home-title">
      <div className="tf-hero-copy">
        <h1 id="tf-home-title" tabIndex={-1}><span>Your restaurant.</span>{' '}<span>A better first impression.</span></h1>
        <p className="tf-hero-intro">Create a website from your menu, photos, and ideas. Make it yours before you publish.</p>
        <div className="tf-actions">
          <PageLink className="tf-button tf-button-primary" href={startPath} navigate={navigate} disabled={busy}>Create your website <span aria-hidden="true">↗</span></PageLink>
          <PageLink className="tf-button tf-button-secondary" href="/examples" navigate={navigate} disabled={busy}>See examples</PageLink>
        </div>
      </div>
      <div className="tf-hero-visual">
        <div className="tf-device-stage">
          <div className="tf-desktop-device" aria-hidden="true">
            <div className="tf-browser-bar"><span className="tf-browser-dots"><i /><i /><i /></span><span>{featured.name} / Website preview</span><span className="tf-browser-mark">↗</span></div>
            <RestaurantCover example={featured} eager />
          </div>
          <div className="tf-phone-device" aria-hidden="true"><span className="tf-phone-speaker" /><RestaurantCover example={featured} mobile eager /></div>
        </div>
      </div>
    </section>

    <section className="tf-examples-section" data-tf-reveal="" aria-labelledby="tf-home-examples-title">
      <div className="tf-section-heading"><div><p className="tf-eyebrow">Not every restaurant looks alike</p><h2 id="tf-home-examples-title">Neither should<br />their websites.</h2></div><div className="tf-section-aside"><p>An editorial bistro. A bold diner. An after-dark supper house. A quiet Japanese kitchen. Four different ways to make a first impression.</p><PageLink className="tf-text-link" href="/examples" navigate={navigate} disabled={busy}>View all examples <span aria-hidden="true">↗</span></PageLink></div></div>
      <ExampleCardGrid interactive={false} />
      <div className="tf-examples-note"><p>{EXAMPLES_NOTICE}</p></div>
    </section>

    <section className="tf-how" data-tf-reveal="" aria-labelledby="tf-how-title">
      <div className="tf-how-intro"><p className="tf-eyebrow">From your menu to your website</p><h2 id="tf-how-title">You know your restaurant.<br />Start there.</h2><p>No need to start with a blank page. Bring the things that make your place your place.</p><PageLink className="tf-text-link" href={startPath} navigate={navigate} disabled={busy}>Let's make something yours <span aria-hidden="true">↗</span></PageLink></div>
      <ol className="tf-steps">
        <li><span className="tf-step-number" aria-hidden="true">01</span><div><h3>Bring the essentials.</h3><p>Add your restaurant details, menu, and photos. Review your dishes and prices before confirming the menu.</p></div></li>
        <li><span className="tf-step-number" aria-hidden="true">02</span><div><h3>Describe the feeling.</h3><p>Warm and welcoming? Quiet and considered? Tell us what you have in mind, then build a website draft around it.</p></div></li>
        <li><span className="tf-step-number" aria-hidden="true">03</span><div><h3>Review it. Make it yours.</h3><p>Explore the preview, check the content, and refine the design. Decide what feels right before taking a next step toward publishing.</p></div></li>
      </ol>
    </section>

    <section className="tf-operations" data-tf-reveal="" aria-labelledby="tf-operations-title">
      <div className="tf-workspace-concept" aria-label="Illustrative workspace concept, not a live management screen">
        <div className="tf-workspace-top"><span>Table Folk / Workspace</span><span className="tf-concept-label">Concept</span></div>
        <div className="tf-workspace-content"><p className="tf-eyebrow">Behind the website</p><h3>A place for the details.</h3><div className="tf-workspace-row"><span className="tf-workspace-symbol" aria-hidden="true">01</span><div><h4>Menu & photos</h4><p>The content that makes it yours</p></div><span aria-hidden="true">↗</span></div><div className="tf-workspace-row"><span className="tf-workspace-symbol" aria-hidden="true">02</span><div><h4>Website drafts</h4><p>A place to review and refine</p></div><span aria-hidden="true">↗</span></div><div className="tf-workspace-row"><span className="tf-workspace-symbol" aria-hidden="true">03</span><div><h4>Guest requests</h4><p>Requests to review, not guaranteed seats</p></div><span aria-hidden="true">↗</span></div><p className="tf-workspace-note">Workspace concept. No live restaurant records or activity data are shown.</p></div>
      </div>
      <div className="tf-operations-copy"><p className="tf-eyebrow">For owners. For operators.</p><h2 id="tf-operations-title">The website is just<br />the front of house.</h2><p>Behind it are menus to keep current, drafts to review, and guest requests to consider.</p><p>Our direction is a shared workspace for that work. This illustration shows the idea, not a completed management screen.</p><PageLink className="tf-text-link" href={startPath} navigate={navigate} disabled={busy}>{authenticated ? 'Open your workspace' : 'Start with your restaurant'} <span aria-hidden="true">↗</span></PageLink></div>
    </section>

    <section className="tf-faq" aria-labelledby="tf-faq-title"><div><p className="tf-eyebrow">Before you start</p><h2 id="tf-faq-title">A few good<br />questions.</h2></div><div className="tf-questions">{questions.map((item) => <details key={item.question}><summary>{item.question}<span className="tf-faq-plus" aria-hidden="true" /></summary><p>{item.answer}</p></details>)}</div></section>

    <section className="tf-closing" aria-labelledby="tf-closing-title"><div><p className="tf-eyebrow">Bring your restaurant to the table</p><h2 id="tf-closing-title">A little more you.<br />A better place to begin.</h2><p>Your menu, your photos, your point of view.</p></div><PageLink className="tf-button tf-button-primary" href={startPath} navigate={navigate} disabled={busy}>Create your website <span aria-hidden="true">↗</span></PageLink>    </section>
  </div>;
}
