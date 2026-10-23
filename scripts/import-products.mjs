/**
 * Adobe Commerce (ACCS) product importer
 *
 * Reads scripts/agilent-products.json and creates products via REST API.
 *
 * Usage:
 *   ACCS_TOKEN=<admin_token> node scripts/import-products.mjs
 *   ACCS_TOKEN=<admin_token> node scripts/import-products.mjs --dry-run
 *   ACCS_TOKEN=<admin_token> node scripts/import-products.mjs --category hplc-columns
 *
 * To get ACCS_TOKEN:
 *   1. Admin token (username/password):
 *      curl -X POST <ADMIN_REST_BASE>/rest/V1/integration/admin/token \
 *        -H 'Content-Type: application/json' \
 *        -d '{"username":"admin","password":"<pwd>"}'
 *
 *   2. IMS OAuth token:
 *      Exchange your IMS client_id + client_secret for a bearer token at
 *      https://ims-na1.adobelogin.com/ims/token/v3
 *      then pass it as ACCS_TOKEN.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = process.env.ACCS_BASE_URL
  || 'https://na1-sandbox.api.commerce.adobe.com/99KczrjNJgWyV4LRYNKyjv';
const TOKEN = process.env.ACCS_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');
const categoryFlagIdx = process.argv.indexOf('--category');
const CATEGORY_FILTER = process.argv.find(a => a.startsWith('--category='))?.split('=')[1]
  || (categoryFlagIdx !== -1 ? process.argv[categoryFlagIdx + 1] : undefined);
const CONCURRENCY = 3;  // parallel requests
const DELAY_MS = 300;   // ms between batches

if (!TOKEN && !DRY_RUN) {
  console.error('❌  ACCS_TOKEN is not set. Run with --dry-run to test, or set the env var.');
  process.exit(1);
}

// ─── REST helper ─────────────────────────────────────────────────────────────
async function restPost(path, body) {
  const url = `${BASE_URL}/rest/default/V1${path}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] POST ${url}`);
    console.log(`           ${JSON.stringify(body).slice(0, 120)}…`);
    return { id: 'dry-run', sku: body.product?.sku };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Category creation ───────────────────────────────────────────────────────
const categoryIdCache = {};

async function ensureCategory(name, parentId = 2) {
  if (categoryIdCache[name]) return categoryIdCache[name];

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const body = {
    category: {
      parent_id: parentId,
      name,
      is_active: true,
      include_in_menu: true,
      custom_attributes: [
        { attribute_code: 'url_key', value: slug },
        { attribute_code: 'display_mode', value: 'PRODUCTS' },
        { attribute_code: 'is_anchor', value: '1' },
      ],
    },
  };

  try {
    const result = await restPost('/categories', body);
    const id = result.id || result;
    categoryIdCache[name] = id;
    console.log(`  📁 Category created: "${name}" → id ${id}`);
    return id;
  } catch (err) {
    if (err.message.includes('already exists') || DRY_RUN) {
      categoryIdCache[name] = -1;
      return -1;
    }
    throw err;
  }
}

// ─── Product creation ─────────────────────────────────────────────────────────
function buildProductPayload(product, categoryId) {
  const { sku, name, price, description, image, specs, weight, status, visibility, attribute_set } = product;

  const payload = {
    product: {
      sku,
      name,
      price: price || 0,
      status: status ?? 1,
      visibility: visibility ?? 4,
      type_id: 'simple',
      attribute_set_id: 4, // Default attribute set
      weight: weight || 0.5,
      extension_attributes: {
        category_links: categoryId > 0
          ? [{ category_id: String(categoryId), position: 0 }]
          : [],
      },
      custom_attributes: [
        { attribute_code: 'description', value: description || name },
        { attribute_code: 'short_description', value: specs ? `${specs}` : name },
        { attribute_code: 'url_key', value: sku.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
      ],
    },
  };

  return payload;
}

async function importProduct(product, categoryId) {
  const payload = buildProductPayload(product, categoryId);
  const result = await restPost('/products', payload);
  return result;
}

// ─── Batch runner ─────────────────────────────────────────────────────────────
async function runBatch(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push({ ok: true, value: s.value });
      else results.push({ ok: false, error: s.reason?.message });
    }
    if (i + CONCURRENCY < items.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dataPath = path.join(__dirname, 'agilent-products.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));

  let products = data.products;
  if (CATEGORY_FILTER) {
    products = products.filter(p => p.category_id === CATEGORY_FILTER);
    console.log(`🔍 Filtering to category: ${CATEGORY_FILTER} (${products.length} products)`);
  }

  console.log(`\n📦 Import: ${products.length} products → ${BASE_URL}`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  // Group by commerce_category
  const byCategory = {};
  for (const p of products) {
    const cat = p.commerce_category || p.category_name;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  let totalOk = 0;
  let totalFail = 0;

  for (const [catName, catProducts] of Object.entries(byCategory)) {
    console.log(`\n📂 Category: ${catName} (${catProducts.length} products)`);
    const categoryId = await ensureCategory(catName);

    const results = await runBatch(catProducts, (p) => importProduct(p, categoryId));

    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);
    totalOk += ok;
    totalFail += fail.length;

    console.log(`   ✅ ${ok} created`);
    if (fail.length) {
      console.log(`   ❌ ${fail.length} failed:`);
      for (const f of fail) console.log(`      ${f.error}`);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Total: ✅ ${totalOk} created  ❌ ${totalFail} failed`);

  if (DRY_RUN) {
    console.log('\n💡 Dry run complete. To import for real:');
    console.log('   ACCS_TOKEN=<your_token> node scripts/import-products.mjs');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
