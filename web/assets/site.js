// Mouse glow effect
        document.addEventListener('mousemove', (e) => {
            document.documentElement.style.setProperty('--cursor-x', e.clientX + 'px');
            document.documentElement.style.setProperty('--cursor-y', e.clientY + 'px');
        });

        // GSAP ScrollTrigger animations
        gsap.registerPlugin(ScrollTrigger);

        // Section reveals
        document.querySelectorAll('.section-reveal').forEach((el, i) => {
            gsap.to(el, {
                opacity: 1,
                y: 0,
                duration: 0.8,
                ease: 'power3.out',
                scrollTrigger: {
                    trigger: el,
                    start: 'top 85%',
                    toggleActions: 'play none none none'
                },
                delay: i % 3 * 0.1
            });
        });

        // TOC visibility and active state
        const tocSidebar = document.getElementById('tocSidebar');
        const sections = ['hero', 'philosophy', 'performance', 'architecture', 'tools', 'safety', 'evolution', 'languages', 'quickstart'];
        
        window.addEventListener('scroll', () => {
            if (window.scrollY > 600) {
                tocSidebar.classList.add('visible');
            } else {
                tocSidebar.classList.remove('visible');
            }

            let current = '';
            sections.forEach(id => {
                const section = document.getElementById(id);
                if (section) {
                    const rect = section.getBoundingClientRect();
                    if (rect.top <= 200) {
                        current = id;
                    }
                }
            });

            document.querySelectorAll('.toc-dot').forEach(dot => {
                dot.classList.toggle('active', dot.dataset.section === current);
            });
        });

        // Smooth scroll for nav links
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function(e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        // Test counter animation
        const counter = document.querySelector('.test-counter');
        if (counter) {
            const target = parseInt(counter.dataset.target);
            let current = 0;
            const increment = Math.ceil(target / 50);
            const timer = setInterval(() => {
                current += increment;
                if (current >= target) {
                    current = target;
                    clearInterval(timer);
                }
                counter.textContent = current;
            }, 30);
        }

        // Commit graph bars
        const graph1 = document.getElementById('commitGraph1');
        if (graph1) {
            for (let i = 0; i < 18; i++) {
                const bar = document.createElement('div');
                bar.className = 'commit-bar';
                bar.style.height = Math.max(8, Math.random() * 48 + 8) + 'px';
                bar.style.opacity = 0.3 + (i / 18) * 0.7;
                graph1.appendChild(bar);
            }
        }

        // Performance bars animation
        gsap.utils.toArray('.performance-bar').forEach(bar => {
            const width = bar.style.width;
            bar.style.width = '0%';
            gsap.to(bar, {
                width: width || '100%',
                duration: 1.5,
                ease: 'power2.out',
                scrollTrigger: {
                    trigger: bar,
                    start: 'top 90%'
                }
            });
        });