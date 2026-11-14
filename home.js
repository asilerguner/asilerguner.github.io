(() => {
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];

  $('#year').textContent = new Date().getFullYear();

  /* mobile menu */
  const menuBtn = $('#menuBtn'), menu = $('#menu');
  const setMenu = open => { menu.classList.toggle('open', open); menuBtn.setAttribute('aria-expanded', open); };
  menuBtn.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
  $$('a', menu).forEach(a => a.addEventListener('click', () => setMenu(false)));
  addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  /* active nav link */
  const navLinks = $$('.links a');
  const secIO = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) navLinks.forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + e.target.id ? 'true' : 'false'));
  }), { rootMargin: '-45% 0px -50% 0px' });
  ['work', 'approach', 'about', 'apps'].forEach(id => { const el = document.getElementById(id); if (el) secIO.observe(el); });

  /* reveal on scroll */
  const revealIO = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); }
  }), { threshold: .1, rootMargin: '0px 0px -30px 0px' });
  $$('[data-reveal]').forEach(el => rm ? el.classList.add('in') : revealIO.observe(el));

  /* contact form */
  const form = $('#contactForm');
  if (form) {
    const note = $('#formNote');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const b = form.querySelector('button[type=submit]'); b.disabled = true; note.textContent = 'Sending…';
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then(r => { if (r.ok) { note.textContent = 'Thanks, your message is sent. I will reply soon.'; form.reset(); } else throw 0; })
        .catch(() => { note.textContent = 'That did not send. Please email asilerguner@gmail.com directly.'; })
        .finally(() => { b.disabled = false; });
    });
  }
})();
