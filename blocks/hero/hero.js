export default function decorate(block) {
  const slides = [...block.querySelectorAll(':scope > div')];
  if (slides.length === 0) return;

  // Set background images
  slides.forEach((slide) => {
    const inner = slide.querySelector(':scope > div');
    if (!inner) return;
    const pic = inner.querySelector('p > picture, p > img');
    if (!pic) return;
    const img = pic.tagName === 'IMG' ? pic : pic.querySelector('img');
    if (!img) return;
    const src = img.currentSrc || img.src;
    if (src) {
      slide.style.backgroundImage = `url('${src}')`;
      slide.style.backgroundSize = 'cover';
      slide.style.backgroundPosition = 'center';
    }
    pic.closest('p')?.remove();
  });

  if (slides.length === 1) return;

  // Add carousel structure
  slides.forEach((slide, i) => {
    slide.setAttribute('aria-hidden', i !== 0);
    slide.dataset.index = i;
  });

  // Dots
  const dotsNav = document.createElement('div');
  dotsNav.className = 'hero-dots';
  dotsNav.setAttribute('aria-label', 'Slide navigation');
  slides.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.dataset.index = i;
    dotsNav.append(dot);
  });
  block.append(dotsNav);

  // Prev / next buttons
  const prev = document.createElement('button');
  prev.className = 'hero-nav hero-prev';
  prev.setAttribute('aria-label', 'Previous slide');
  prev.innerHTML = '<span>&#8249;</span>';

  const next = document.createElement('button');
  next.className = 'hero-nav hero-next';
  next.setAttribute('aria-label', 'Next slide');
  next.innerHTML = '<span>&#8250;</span>';

  block.append(prev, next);

  let current = 0;
  let timer;

  function goTo(index) {
    const dots = [...dotsNav.querySelectorAll('.hero-dot')];
    slides[current].classList.remove('active');
    slides[current].setAttribute('aria-hidden', true);
    dots[current].classList.remove('active');

    current = (index + slides.length) % slides.length;

    slides[current].classList.add('active');
    slides[current].setAttribute('aria-hidden', false);
    dots[current].classList.add('active');
  }

  slides[0].classList.add('active');

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => goTo(current + 1), 5000);
  }

  prev.addEventListener('click', () => { goTo(current - 1); startTimer(); });
  next.addEventListener('click', () => { goTo(current + 1); startTimer(); });
  dotsNav.addEventListener('click', (e) => {
    const dot = e.target.closest('.hero-dot');
    if (dot) { goTo(parseInt(dot.dataset.index, 10)); startTimer(); }
  });

  // Pause on hover
  block.addEventListener('mouseenter', () => clearInterval(timer));
  block.addEventListener('mouseleave', startTimer);

  startTimer();
}
