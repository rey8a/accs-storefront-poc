export default function decorate(block) {
  const rows = [...block.querySelectorAll(':scope > div')];
  const config = {};
  const contentRows = [];

  rows.forEach((row) => {
    const cols = row.querySelectorAll(':scope > div');
    const key = cols[0]?.textContent?.trim().toLowerCase();
    if (key === 'type' || key === 'position') {
      config[key] = cols[1]?.textContent?.trim();
      row.remove();
    } else {
      contentRows.push(row);
    }
  });

  if (contentRows.length === 0) {
    block.closest('.enrichment-wrapper')?.remove();
  }
}
