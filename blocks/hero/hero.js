export default function decorate(block) {
  [...block.querySelectorAll(':scope > div')].forEach((row) => {
    const inner = row.querySelector(':scope > div');
    if (!inner) return;

    const pic = inner.querySelector('p > picture, p > img');
    if (!pic) return;

    const img = pic.tagName === 'IMG' ? pic : pic.querySelector('img');
    if (!img) return;

    // Use srcset if available, fall back to src
    const src = img.currentSrc || img.src;
    if (src) {
      row.style.backgroundImage = `url('${src}')`;
      row.style.backgroundSize = 'cover';
      row.style.backgroundPosition = 'center';
    }

    // Remove the <p> wrapping the picture from the text flow
    pic.closest('p')?.remove();
  });
}
