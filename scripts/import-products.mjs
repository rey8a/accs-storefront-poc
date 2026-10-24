/**
 * Adobe Commerce (ACCS) product importer
 *
 * Reads scripts/agilent-products.json and creates products via REST API.
 * Supports simple, configurable, and quote-only instrument products.
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
const CONCURRENCY = 3;
const DELAY_MS = 300;

if (!TOKEN && !DRY_RUN) {
  console.error('❌  ACCS_TOKEN is not set. Run with --dry-run to test, or set the env var.');
  process.exit(1);
}

// ─── REST helpers ─────────────────────────────────────────────────────────────
async function restPost(path, body) {
  const url = `${BASE_URL}/rest/default/V1${path}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] POST ${url}`);
    console.log(`           ${JSON.stringify(body).slice(0, 120)}…`);
    return { id: 'dry-run', sku: body.product?.sku };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function restPut(path, body) {
  const url = `${BASE_URL}/rest/default/V1${path}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] PUT  ${url}`);
    console.log(`           ${JSON.stringify(body).slice(0, 120)}…`);
    return { id: 'dry-run' };
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function restGet(path) {
  const url = `${BASE_URL}/rest/default/V1${path}`;
  if (DRY_RUN) {
    console.log(`  [dry-run] GET  ${url}`);
    return null;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ─── Category creation ────────────────────────────────────────────────────────
const categoryIdCache = {};

async function ensureCategory(name, parentId = 2) {
  if (categoryIdCache[name]) return categoryIdCache[name];
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const result = await restPost('/categories', {
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
    });
    const id = result.id || result;
    categoryIdCache[name] = id;
    console.log(`  📁 Category: "${name}" → id ${id}`);
    return id;
  } catch (err) {
    if (err.message.includes('already exists') || DRY_RUN) {
      categoryIdCache[name] = -1;
      return -1;
    }
    throw err;
  }
}

// ─── Attribute creation ───────────────────────────────────────────────────────
const CONFIGURABLE_ATTRIBUTES = {
  column_length:  { label: 'Column Length (mm)', type: 'int',    options: ['30','50','100','150','200'] },
  inner_diameter: { label: 'Inner Diameter (mm)', type: 'decimal', options: ['2.1','3.0','4.6'] },
  gc_length:      { label: 'Column Length (m)',  type: 'int',    options: ['5','10','15','20','30','60'] },
  film_thickness: { label: 'Film Thickness (µm)', type: 'decimal', options: ['0.10','0.18','0.25','0.36','0.50','1.00'] },
};

const attributeIdCache = {};

async function ensureAttribute(code) {
  if (attributeIdCache[code]) return attributeIdCache[code];
  const def = CONFIGURABLE_ATTRIBUTES[code];
  if (!def) throw new Error(`Unknown attribute: ${code}`);

  // Check if it already exists
  const existing = await restGet(`/products/attributes/${code}`);
  if (existing?.attribute_id) {
    attributeIdCache[code] = existing.attribute_id;
    console.log(`  🏷  Attribute "${code}" exists → id ${existing.attribute_id}`);
    return existing.attribute_id;
  }

  // Create the attribute
  const options = def.options.map(v => ({ label: v, value: '' }));
  const result = await restPost('/products/attributes', {
    attribute: {
      attribute_code: code,
      frontend_label: def.label,
      backend_type: def.type === 'int' ? 'int' : 'decimal',
      frontend_input: 'select',
      is_required: false,
      is_searchable: true,
      is_filterable: true,
      is_comparable: true,
      is_visible_on_front: true,
      is_html_allowed_on_front: false,
      used_for_sort_by: false,
      options: options.map(o => ({ label: o.label, sort_order: 0, is_default: false, store_labels: [] })),
    },
  });
  const id = result.attribute_id;
  attributeIdCache[code] = id;
  console.log(`  🏷  Attribute "${code}" created → id ${id}`);
  return id;
}

// ─── Simple product creation ──────────────────────────────────────────────────
function buildSimplePayload(product, categoryId) {
  const { sku, name, price, description, specs, weight, status, visibility, quote_only } = product;
  const customAttrs = [
    { attribute_code: 'description', value: description || name },
    { attribute_code: 'short_description', value: specs || name },
    { attribute_code: 'url_key', value: sku.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
  ];
  if (quote_only) {
    customAttrs.push({ attribute_code: 'quote_only', value: '1' });
  }
  return {
    product: {
      sku,
      name,
      price: price || 0,
      status: status ?? 1,
      visibility: visibility ?? 4,
      type_id: 'simple',
      attribute_set_id: 4,
      weight: weight || 0.5,
      extension_attributes: {
        category_links: categoryId > 0 ? [{ category_id: String(categoryId), position: 0 }] : [],
      },
      custom_attributes: customAttrs,
    },
  };
}

async function importSimple(product, categoryId) {
  const payload = buildSimplePayload(product, categoryId);
  return restPost('/products', payload);
}

// ─── Configurable product creation ───────────────────────────────────────────
async function importConfigurable(product, categoryId) {
  const { sku, name, price, description, specs, weight, configurable_attributes, child_options, children_skus } = product;

  // 1. Ensure all variant attributes exist
  const attrIds = {};
  for (const attrCode of configurable_attributes) {
    attrIds[attrCode] = await ensureAttribute(attrCode);
  }

  // 2. Create the configurable parent product
  const confResult = await restPost('/products', {
    product: {
      sku,
      name,
      price: price || 0,
      status: 1,
      visibility: 4,
      type_id: 'configurable',
      attribute_set_id: 4,
      weight: weight || 0.5,
      extension_attributes: {
        category_links: categoryId > 0 ? [{ category_id: String(categoryId), position: 0 }] : [],
      },
      custom_attributes: [
        { attribute_code: 'description', value: description || name },
        { attribute_code: 'short_description', value: specs || name },
        { attribute_code: 'url_key', value: sku.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
      ],
    },
  });
  console.log(`  🔧 Configurable created: ${sku}`);

  // 3. Add configurable options to the parent
  for (const attrCode of configurable_attributes) {
    const attrId = attrIds[attrCode];
    if (!attrId || attrId === 'dry-run') continue;

    const uniqueValues = [...new Set(child_options.map(o => o[attrCode]))];
    const values = uniqueValues.map((v, i) => ({
      value_index: i + 1,
      label: String(v),
    }));

    await restPost(`/configurable-products/${encodeURIComponent(sku)}/options`, {
      option: {
        attribute_id: String(attrId),
        label: CONFIGURABLE_ATTRIBUTES[attrCode]?.label || attrCode,
        position: 0,
        is_use_default: true,
        values,
      },
    });
  }

  // 4. Link children to the configurable
  if (!DRY_RUN && children_skus) {
    for (const childSku of children_skus) {
      try {
        await restPost(`/configurable-products/${encodeURIComponent(sku)}/child`, {
          childSku,
        });
        console.log(`     ↳ linked child: ${childSku}`);
      } catch (err) {
        console.warn(`     ⚠  could not link ${childSku}: ${err.message.slice(0, 80)}`);
      }
    }
  } else if (DRY_RUN && children_skus) {
    children_skus.forEach(childSku => console.log(`  [dry-run]    ↳ link child: ${childSku}`));
  }

  return confResult;
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

  // Separate by type
  const simples       = products.filter(p => (p.type_id || p.type) === 'simple');
  const configurables = products.filter(p => (p.type_id || p.type) === 'configurable');

  console.log(`\n📦 Import: ${products.length} total products → ${BASE_URL}`);
  console.log(`   ${simples.length} simple  |  ${configurables.length} configurable`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  let totalOk = 0;
  let totalFail = 0;

  // ── Simple products ──────────────────────────────────────────────────────
  const simplesByCategory = {};
  for (const p of simples) {
    const cat = p.commerce_category || p.category_name;
    if (!simplesByCategory[cat]) simplesByCategory[cat] = [];
    simplesByCategory[cat].push(p);
  }

  for (const [catName, catProducts] of Object.entries(simplesByCategory)) {
    console.log(`📂 Simple / ${catName} (${catProducts.length})`);
    const categoryId = await ensureCategory(catName);
    const results = await runBatch(catProducts, (p) => importSimple(p, categoryId));
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);
    totalOk += ok;
    totalFail += fail.length;
    console.log(`   ✅ ${ok} created`);
    if (fail.length) fail.forEach(f => console.log(`   ❌ ${f.error}`));
  }

  // ── Configurable products ────────────────────────────────────────────────
  for (const p of configurables) {
    const catName = p.commerce_category || p.category_name;
    console.log(`\n🔀 Configurable: ${p.sku} / ${catName}`);
    const categoryId = await ensureCategory(catName);
    try {
      await importConfigurable(p, categoryId);
      totalOk++;
    } catch (err) {
      console.error(`   ❌ ${err.message.slice(0, 120)}`);
      totalFail++;
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
