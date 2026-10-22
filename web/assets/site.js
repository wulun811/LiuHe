// Mouse glow effect
document.addEventListener('mousemove', (e) => {
  document.documentElement.style.setProperty('--cursor-x', e.clientX + 'px');
  document.documentElement.style.setProperty('--cursor-y', e.clientY + 'px');
});

const reveals = document.querySelectorAll('.section-reveal');

if (window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);

  reveals.forEach((el, i) => {
    gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none none' },
      delay: (i % 3) * 0.08
    });
  });

  gsap.utils.toArray('.bar-fill').forEach((bar) => {
    const width = bar.style.width;
    bar.style.width = '0%';
    gsap.to(bar, {
      width: width || '100%',
      duration: 1.4,
      ease: 'power2.out',
      scrollTrigger: { trigger: bar, start: 'top 92%' }
    });
  });
} else {
  reveals.forEach((el) => { el.style.opacity = 1; el.style.transform = 'none'; });
}

// TOC visibility and active state
const tocSidebar = document.getElementById('tocSidebar');
const sections = ['hero', 'premise', 'graph', 'loop', 'sequence', 'done', 'machines', 'architecture', 'tools', 'proof', 'start'];

if (tocSidebar) {
  window.addEventListener('scroll', () => {
    tocSidebar.classList.toggle('visible', window.scrollY > 600);

    let current = '';
    sections.forEach((id) => {
      const section = document.getElementById(id);
      if (section && section.getBoundingClientRect().top <= 200) current = id;
    });

    document.querySelectorAll('.toc-dot').forEach((dot) => {
      dot.classList.toggle('active', dot.dataset.section === current);
    });
  });
}

// Smooth scroll for in-page links
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
