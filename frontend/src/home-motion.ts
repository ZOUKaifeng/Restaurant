// Progressive enhancement: all content stays visible without JS or observers.
export function attachHomeMotion(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view || typeof view.matchMedia !== 'function' || typeof view.IntersectionObserver !== 'function') return () => {};

  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  if (typeof preference.addEventListener !== 'function' || typeof preference.removeEventListener !== 'function') return () => {};
  const hero = root.querySelector<HTMLElement>('.tf-hero-visual');
  const sections = [...root.querySelectorAll<HTMLElement>('[data-tf-reveal]')];
  const pending = new Set(sections.filter((section) => section.getBoundingClientRect().top >= view.innerHeight));
  let heroVisible = !!hero && hero.getBoundingClientRect().bottom > 0 && hero.getBoundingClientRect().top < view.innerHeight;
  let disposed = false;

  function updatePhoto() {
    root.classList.toggle('tf-photo-active', heroVisible && !document.hidden && !preference.matches);
  }
  const observer = new view.IntersectionObserver((entries) => {
    if (disposed) return;
    for (const entry of entries) {
      if (entry.target === hero) {
        heroVisible = entry.isIntersecting;
        updatePhoto();
      } else if (entry.isIntersecting && pending.delete(entry.target as HTMLElement)) {
        observer.unobserve(entry.target);
        if (!preference.matches) entry.target.classList.add('tf-reveal-enter');
      }
    }
  }, { threshold: 0 });

  function preferenceChanged() {
    updatePhoto();
    if (preference.matches) sections.forEach((section) => section.classList.remove('tf-reveal-enter'));
  }
  function focused(event: FocusEvent) {
    // Keyboard navigation must not wait for or restart an entrance animation.
    const target = event.target as HTMLElement | null;
    if (target?.closest('.tf-hero-copy')) root.classList.add('tf-hero-focused');
    const section = target?.closest<HTMLElement>('[data-tf-reveal]');
    if (!section || !root.contains(section)) return;
    pending.delete(section);
    observer.unobserve(section);
    section.classList.remove('tf-reveal-enter');
  }

  if (hero) observer.observe(hero);
  pending.forEach((section) => observer.observe(section));
  updatePhoto();
  document.addEventListener('visibilitychange', updatePhoto);
  preference.addEventListener('change', preferenceChanged);
  root.addEventListener('focusin', focused);

  return () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener('visibilitychange', updatePhoto);
    preference.removeEventListener('change', preferenceChanged);
    root.removeEventListener('focusin', focused);
    root.classList.remove('tf-photo-active', 'tf-hero-focused');
    sections.forEach((section) => section.classList.remove('tf-reveal-enter'));
    pending.clear();
  };
}
