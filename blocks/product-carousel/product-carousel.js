export default function decorate(block) {
  const rows = [...block.querySelectorAll(':scope > div')];
  const config = {};

  rows.forEach((row) => {
    const cols = row.querySelectorAll(':scope > div');
    const key = cols[0]?.textContent?.trim().toLowerCase().replace(/\s+/g, '');
    const val = cols[1]?.textContent?.trim();
    if (key && val) {
      config[key] = val;
      row.remove();
    }
  });

  if (!block.children.length) {
    block.closest('.product-carousel-wrapper')?.remove();
  }
}
