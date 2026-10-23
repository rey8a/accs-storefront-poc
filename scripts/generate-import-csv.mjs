/**
 * Converts agilent-products.json → Magento import CSV
 * Output: scripts/agilent-products-import.csv
 *
 * Usage: node scripts/generate-import-csv.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const data = JSON.parse(readFileSync(path.join(__dirname, 'agilent-products.json'), 'utf-8'));

// Magento product CSV columns (subset needed for simple products)
const COLUMNS = [
  'sku',
  'store_view_code',
  'attribute_set_code',
  'product_type',
  'categories',
  'product_websites',
  'name',
  'description',
  'short_description',
  'weight',
  'product_online',
  'tax_class_name',
  'visibility',
  'price',
  'special_price',
  'url_key',
  'meta_title',
  'meta_keywords',
  'meta_description',
  'base_image',
  'base_image_label',
  'small_image',
  'small_image_label',
  'thumbnail_image',
  'thumbnail_image_label',
  'qty',
  'out_of_stock_qty',
  'use_config_min_qty',
  'is_qty_decimal',
  'allow_backorders',
  'use_config_backorders',
  'min_cart_qty',
  'use_config_min_sale_qty',
  'max_cart_qty',
  'use_config_max_sale_qty',
  'is_in_stock',
  'notify_on_stock_below',
  'use_config_notify_stock_qty',
  'manage_stock',
  'use_config_manage_stock',
  'use_config_qty_increments',
  'qty_increments',
  'use_config_enable_qty_inc',
  'enable_qty_increments',
  'is_decimal_divided',
  'website_id',
  'related_skus',
  'crosssell_skus',
  'upsell_skus',
  'additional_attributes',
];

function escapeCSV(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toUrlKey(sku, name) {
  return sku.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function categoryPath(product) {
  // Magento category path format: "Default Category/Parent/Child"
  return `Default Category/${product.commerce_category || product.category_name}`;
}

const rows = [COLUMNS.join(',')];

for (const p of data.products) {
  const shortDesc = p.specs
    ? `${p.name}. ${p.specs}`
    : p.name;

  const desc = p.description || shortDesc;

  const row = {
    sku: p.sku,
    store_view_code: '',              // empty = all store views
    attribute_set_code: 'Default',
    product_type: 'simple',
    categories: categoryPath(p),
    product_websites: 'base',
    name: p.name,
    description: desc,
    short_description: shortDesc.slice(0, 255),
    weight: p.weight || '0.5',
    product_online: '1',
    tax_class_name: 'Taxable Goods',
    visibility: 'Catalog, Search',
    price: p.price || '0',
    special_price: '',
    url_key: toUrlKey(p.sku, p.name),
    meta_title: p.name.slice(0, 70),
    meta_keywords: p.category_name,
    meta_description: shortDesc.slice(0, 160),
    base_image: p.image || '',
    base_image_label: p.image ? p.name.slice(0, 70) : '',
    small_image: p.image || '',
    small_image_label: p.image ? p.name.slice(0, 70) : '',
    thumbnail_image: p.image || '',
    thumbnail_image_label: p.image ? p.name.slice(0, 70) : '',
    qty: '100',
    out_of_stock_qty: '0',
    use_config_min_qty: '1',
    is_qty_decimal: '0',
    allow_backorders: '0',
    use_config_backorders: '1',
    min_cart_qty: '1',
    use_config_min_sale_qty: '1',
    max_cart_qty: '0',
    use_config_max_sale_qty: '1',
    is_in_stock: '1',
    notify_on_stock_below: '',
    use_config_notify_stock_qty: '1',
    manage_stock: '1',
    use_config_manage_stock: '1',
    use_config_qty_increments: '1',
    qty_increments: '0',
    use_config_enable_qty_inc: '1',
    enable_qty_increments: '0',
    is_decimal_divided: '0',
    website_id: '',
    related_skus: '',
    crosssell_skus: '',
    upsell_skus: '',
    additional_attributes: `specs=${p.specs || ''}`,
  };

  rows.push(COLUMNS.map(col => escapeCSV(row[col])).join(','));
}

const outPath = path.join(__dirname, 'agilent-products-import.csv');
writeFileSync(outPath, rows.join('\n'), 'utf-8');
console.log(`✅  Written ${data.products.length} products → ${outPath}`);
console.log(`\nUpload steps:`);
console.log(`  1. Admin → System → Data Transfer → Import`);
console.log(`  2. Entity Type: Products`);
console.log(`  3. Import Behavior: Add/Update`);
console.log(`  4. Select File: scripts/agilent-products-import.csv`);
console.log(`  5. Check Data → Import`);
