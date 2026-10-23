/**
 * Agilent product scraper
 * Scrapes 20+ products per category and saves import-ready JSON.
 *
 * Usage: node scripts/scrape-agilent.mjs
 * Output: scripts/agilent-products.json
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CATEGORIES = [
  {
    id: 'hplc-columns',
    name: 'HPLC Columns',
    url: 'https://www.agilent.com/en/product/hplc-columns',
    commerceCategory: 'Chromatography Columns',
  },
  {
    id: 'gc-columns',
    name: 'GC Columns',
    url: 'https://www.agilent.com/en/product/gc-columns',
    commerceCategory: 'GC Columns and Supplies',
  },
  {
    id: 'sample-preparation',
    name: 'Sample Preparation',
    url: 'https://www.agilent.com/en/product/sample-preparation',
    commerceCategory: 'Sample Preparation',
  },
  {
    id: 'gas-chromatography',
    name: 'Gas Chromatography',
    url: 'https://www.agilent.com/en/product/gas-chromatography',
    commerceCategory: 'Gas Chromatography',
  },
];

const TARGET_PER_CATEGORY = 25;

/** Build a URL-safe SKU from the product name and a counter */
function toSku(categoryId, name, idx) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `AGIL-${categoryId.slice(0, 6).toUpperCase()}-${slug}-${idx}`;
}

/** Scrape product links from a category listing page, following pagination */
async function collectProductLinks(page, categoryUrl) {
  const links = new Set();

  await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Collect all product links visible on the page
  for (let attempt = 0; attempt < 6 && links.size < TARGET_PER_CATEGORY; attempt++) {
    const hrefs = await page.$$eval('a[href]', (els) =>
      els
        .map((el) => el.href)
        .filter((h) => /\/en\/products?\/[\w-]+\/.+/.test(h) && !/category|search/.test(h))
    );
    hrefs.forEach((h) => links.add(h));

    // Try clicking "Load more" / "Show more" / pagination
    const loadMore = await page.$('button:has-text("Load more"), button:has-text("Show more"), a:has-text("Next")');
    if (!loadMore || links.size >= TARGET_PER_CATEGORY) break;
    await loadMore.click();
    await page.waitForTimeout(2000);
  }

  return [...links].slice(0, TARGET_PER_CATEGORY);
}

/** Scrape product detail from a product page */
async function scrapeProductDetail(page, url, categoryId, idx) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);

    const name = await page.$eval(
      'h1, [class*="product-title"], [class*="product-name"]',
      (el) => el.textContent.trim()
    ).catch(() => '');

    if (!name) return null;

    const description = await page.$eval(
      '[class*="product-description"], [class*="product-detail"] p, .product-overview p, main p',
      (el) => el.textContent.trim().slice(0, 500)
    ).catch(() => '');

    const partNumbers = await page.$$eval(
      '[class*="part-number"], [class*="part-num"], [class*="model"], td:has-text("Part Number") + td, td:has-text("Model") + td',
      (els) => els.map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3)
    ).catch(() => []);

    const imageUrl = await page.$eval(
      '[class*="product"] img[src], .product-image img[src]',
      (el) => el.src
    ).catch(() => '');

    const price = await page.$eval(
      '[class*="price"], [class*="cost"]',
      (el) => el.textContent.replace(/[^0-9.]/g, '').trim()
    ).catch(() => '');

    const sku = partNumbers[0] || toSku(categoryId, name, idx);

    return {
      sku,
      name,
      description: description || `${name} - Agilent Technologies`,
      price: parseFloat(price) || 0,
      image: imageUrl,
      url,
      part_numbers: partNumbers,
    };
  } catch (err) {
    console.error(`  ✗ failed ${url}: ${err.message}`);
    return null;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Accept cookies once
  await page.goto('https://www.agilent.com/en-us/products', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const cookieBtn = await page.$('button:has-text("Accept All")');
  if (cookieBtn) { await cookieBtn.click(); await page.waitForTimeout(500); }

  const allProducts = [];

  for (const category of CATEGORIES) {
    console.log(`\n📦 Category: ${category.name} → ${category.url}`);

    // Step 1: collect product links from listing page
    let productLinks = [];
    try {
      productLinks = await collectProductLinks(page, category.url);
    } catch (err) {
      console.error(`  ✗ listing failed: ${err.message}`);
    }

    // If listing page gave no direct product links, try sub-category pages
    if (productLinks.length < 5) {
      console.log(`  → Listing sparse (${productLinks.length}), scraping sub-category links…`);
      const subLinks = await page.$$eval('a[href*="/en/product"]', (els) =>
        [...new Set(els.map((e) => e.href))].filter((h) => /\/en\/product\/[\w-]+$/.test(h))
      ).catch(() => []);

      for (const sub of subLinks.slice(0, 4)) {
        if (productLinks.length >= TARGET_PER_CATEGORY) break;
        try {
          const more = await collectProductLinks(page, sub);
          productLinks.push(...more);
        } catch { /* skip */ }
      }
      productLinks = [...new Set(productLinks)].slice(0, TARGET_PER_CATEGORY);
    }

    console.log(`  → ${productLinks.length} product URLs collected`);

    // Step 2: scrape each product detail
    const categoryProducts = [];
    for (let i = 0; i < productLinks.length; i++) {
      process.stdout.write(`  [${i + 1}/${productLinks.length}] ${productLinks[i].split('/').pop()}…`);
      const product = await scrapeProductDetail(page, productLinks[i], category.id, i + 1);
      if (product) {
        categoryProducts.push({
          ...product,
          category_id: category.id,
          category_name: category.name,
          commerce_category: category.commerceCategory,
        });
        process.stdout.write(' ✓\n');
      } else {
        process.stdout.write(' ✗\n');
      }
      await page.waitForTimeout(300);
    }

    console.log(`  → Scraped ${categoryProducts.length} products`);
    allProducts.push(...categoryProducts);
  }

  await browser.close();

  const output = {
    scraped_at: new Date().toISOString(),
    total: allProducts.length,
    categories: CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      count: allProducts.filter((p) => p.category_id === c.id).length,
    })),
    products: allProducts,
  };

  const outPath = path.join(__dirname, 'agilent-products.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${allProducts.length} products → ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
