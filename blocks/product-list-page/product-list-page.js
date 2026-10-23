// Product Discovery Dropins
import SearchResults from '@dropins/storefront-product-discovery/containers/SearchResults.js';
import Facets from '@dropins/storefront-product-discovery/containers/Facets.js';
import SortBy from '@dropins/storefront-product-discovery/containers/SortBy.js';
import Pagination from '@dropins/storefront-product-discovery/containers/Pagination.js';
import { render as provider } from '@dropins/storefront-product-discovery/render.js';
import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import { search } from '@dropins/storefront-product-discovery/api.js';
// Wishlist Dropin
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';
// Cart Dropin
import * as cartApi from '@dropins/storefront-cart/api.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
// Event Bus
import { events } from '@dropins/tools/event-bus.js';
// AEM
import { readBlockConfig } from '../../scripts/aem.js';
import { fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';
import { getSearchStateFromUrl, applySearchStateToUrl } from './search-url.js';

// Initializers
import '../../scripts/initializers/search.js';
import '../../scripts/initializers/wishlist.js';

// ---------------------------------------------------------------------------
// SKU-based fallback for when Live Search is not yet indexed.
// Probes productSearch first; on errorCode 1001 ("No index") renders a grid
// directly from catalog-index.json + Catalog Service products(skus:[...]).
// ---------------------------------------------------------------------------

let catalogIndex = null;
async function fetchCatalogIndex() {
  if (catalogIndex) return catalogIndex;
  try {
    const res = await fetch('/scripts/catalog-index.json');
    if (res.ok) catalogIndex = await res.json();
  } catch { /* ignore */ }
  return catalogIndex;
}


async function fetchProductsBySkus(skus, endpoint, headers) {
  if (!skus.length) return [];
  const query = `{ products(skus: ${JSON.stringify(skus)}) {
    sku name shortDescription urlKey
    images(roles: ["small_image"]) { url label }
  } }`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    });
    const { data } = await res.json();
    return data?.products ?? [];
  } catch { return []; }
}

function renderSkuGrid(container, products, priceMap) {
  container.innerHTML = '';
  const grid = document.createElement('ol');
  grid.className = 'product-list-page__sku-grid';
  products.forEach((p) => {
    const price = priceMap[p.sku];
    const img = p.images?.[0]?.url ?? '';
    const li = document.createElement('li');
    li.className = 'product-list-page__sku-item';
    li.innerHTML = `
      <a href="/products/default?sku=${encodeURIComponent(p.sku)}" class="product-list-page__sku-link">
        ${img ? `<img src="${img}" alt="${p.name}" loading="lazy" />` : '<div class="product-list-page__sku-no-img"></div>'}
        <p class="product-list-page__sku-name">${p.name}</p>
        ${price ? `<p class="product-list-page__sku-price">$${Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>` : ''}
        <p class="product-list-page__sku-desc">${p.shortDescription ?? ''}</p>
      </a>`;
    grid.appendChild(li);
  });
  container.appendChild(grid);
}

async function trySkuFallback(block, config, csEndpoint, csHeaders) {
  const index = await fetchCatalogIndex();
  if (!index) return false;

  // urlpath from DA.live is the slug, e.g. "chromatography-columns"
  const urlpath = (config.urlpath || '').trim();
  const categoryProducts = index.categories?.[urlpath] ?? [];
  if (!categoryProducts.length) return false;

  const priceMap = Object.fromEntries(categoryProducts.map((p) => [p.sku, p.price]));
  const skus = categoryProducts.map((p) => p.sku);

  const csProducts = await fetchProductsBySkus(skus, csEndpoint, csHeaders);

  // Fall back to static data if Catalog Service returned nothing
  const merged = csProducts.length
    ? csProducts
    : categoryProducts.map((p) => ({
      sku: p.sku, name: p.name, shortDescription: p.description,
      urlKey: p.sku.toLowerCase(), images: [],
    }));

  block.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'search__wrapper search__wrapper--sku-fallback';
  block.appendChild(wrapper);
  renderSkuGrid(wrapper, merged, priceMap);
  return true;
}

export default async function decorate(block) {
  const labels = await fetchPlaceholders();

  const config = readBlockConfig(block);
  const pageSize = parseInt(config.pagesize, 10) || 9;

  // If the static catalog index has products for this category slug, render
  // them directly via products(skus:[...]) — bypasses Live Search entirely.
  // Remove this block once Live Search is provisioned for this environment.
  if (config.urlpath) {
    const index = await fetchCatalogIndex();
    const slug = (config.urlpath || '').trim();
    if (index?.categories?.[slug]?.length) {
      const { CS_FETCH_GRAPHQL } = await import('../../scripts/commerce.js');
      const csConfig = CS_FETCH_GRAPHQL.getConfig?.() ?? {};
      const csEndpoint = typeof csConfig.endpoint === 'string' && csConfig.endpoint
        ? csConfig.endpoint
        : 'https://na1-sandbox.api.commerce.adobe.com/99KczrjNJgWyV4LRYNKyjv/graphql';
      const csHeaders = csConfig.headers ?? {};
      await trySkuFallback(block, config, csEndpoint, csHeaders);
      return;
    }
  }

  const fragment = document.createRange().createContextualFragment(`
    <div class="search__wrapper">
      <div class="search__result-info" role="status" aria-live="polite"></div>
      <div class="search__view-facets"></div>
      <div class="search__facets"></div>
      <div class="search__product-sort"></div>
      <div class="search__product-list"></div>
      <div class="search__pagination"></div>
    </div>
  `);

  const $resultInfo = fragment.querySelector('.search__result-info');
  const $viewFacets = fragment.querySelector('.search__view-facets');
  const $facets = fragment.querySelector('.search__facets');
  const $productSort = fragment.querySelector('.search__product-sort');
  const $productList = fragment.querySelector('.search__product-list');
  const $pagination = fragment.querySelector('.search__pagination');

  block.innerHTML = '';
  block.appendChild(fragment);

  // Add url path back to the block for enrichment, incase enrichment block is
  // executed after the plp block and block config is not available
  if (config.urlpath) {
    block.dataset.urlpath = config.urlpath;
  }

  const searchState = getSearchStateFromUrl(new URL(window.location.href));

  // Default visibility filter for all of our requests
  const visibilityFilter = { attribute: 'visibility', in: ['Search', 'Catalog, Search'] };
  const userFilters = searchState.filter.filter((f) => f.attribute !== 'visibility');

  // Normalize URL (e.g. pipe-separated filter values)
  const normalizedUrl = new URL(window.location.href);
  applySearchStateToUrl(normalizedUrl, searchState);
  window.history.replaceState({}, '', normalizedUrl.toString());

  // Request search based on the page type on block load
  if (config.urlpath) {
    // If it's a category page...
    await search({
      phrase: '', // search all products in the category
      currentPage: searchState.currentPage,
      pageSize,
      sort: searchState?.sort?.length ? searchState.sort : [{ attribute: 'position', direction: 'DESC' }],
      filter: [
        { attribute: 'categoryPath', eq: config.urlpath }, // Add category filter
        // Always add visibility filter to the request
        visibilityFilter,
        ...userFilters,
      ],
    }).catch(() => {
      console.error('Error searching for products');
    });
  } else {
    // Search page: dropin uses only the request (no URL parsing).
    await search({
      phrase: searchState.phrase,
      currentPage: searchState.currentPage,
      pageSize,
      sort: searchState.sort,
      // Always add visibility filter to the request
      filter: [visibilityFilter, ...userFilters],
    }).catch((e) => {
      console.error('Error searching for products', e);
    });
  }

  const requiresPdpConfiguration = (product) => product.typename === 'ComplexProductView'
    || product.attributes?.some((attr) => attr.name === 'ac_giftcard');

  const getAddToCartButton = (product) => {
    const productName = product.name || product.sku;
    const addToCartLabel = `${labels.Global?.AddProductToCart} ${productName}`;

    if (requiresPdpConfiguration(product)) {
      const button = document.createElement('div');
      UI.render(Button, {
        'aria-label': addToCartLabel,
        children: labels.Global?.AddProductToCart,
        icon: Icon({ source: 'Cart' }),
        href: getProductLink(product.urlKey, product.sku),
        variant: 'primary',
      })(button);
      return button;
    }
    const button = document.createElement('div');
    UI.render(Button, {
      'aria-label': addToCartLabel,
      children: labels.Global?.AddProductToCart,
      icon: Icon({ source: 'Cart' }),
      onClick: () => cartApi.addProductsToCart([{ sku: product.sku, quantity: 1 }]),
      variant: 'primary',
      disabled: !product.inStock,
    })(button);
    return button;
  };

  await Promise.all([
    // Sort By
    provider.render(SortBy, {})($productSort),

    // Pagination
    provider.render(Pagination, {
      onPageChange: () => {
        // scroll to the top of the page
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    })($pagination),

    // View Facets Button
    UI.render(Button, {
      children: labels.Global?.Filters,
      icon: Icon({ source: 'Burger' }),
      variant: 'secondary',
      onClick: () => {
        $facets.classList.toggle('search__facets--visible');
      },
    })($viewFacets),

    // Facets
    provider.render(Facets, {})($facets),
    // Product List
    provider.render(SearchResults, {
      routeProduct: (product) => getProductLink(product.urlKey, product.sku),
      slots: {
        ProductImage: (ctx) => {
          const { product, defaultImageProps } = ctx;
          const anchorWrapper = document.createElement('a');
          anchorWrapper.href = getProductLink(product.urlKey, product.sku);
          anchorWrapper.setAttribute('aria-label', product.name || product.sku);

          tryRenderAemAssetsImage(ctx, {
            alias: product.sku,
            imageProps: defaultImageProps,
            wrapper: anchorWrapper,
            params: {
              width: defaultImageProps.width,
              height: defaultImageProps.height,
            },
          });
        },
        ProductActions: (ctx) => {
          const actionsWrapper = document.createElement('div');
          actionsWrapper.className = 'product-discovery-product-actions';
          // Add to Cart Button
          const addToCartBtn = getAddToCartButton(ctx.product);
          addToCartBtn.className = 'product-discovery-product-actions__add-to-cart';
          // Wishlist Button
          const $wishlistToggle = document.createElement('div');
          $wishlistToggle.classList.add('product-discovery-product-actions__wishlist-toggle');
          wishlistRender.render(WishlistToggle, {
            product: ctx.product,
            variant: 'tertiary',
          })($wishlistToggle);
          actionsWrapper.appendChild(addToCartBtn);
          actionsWrapper.appendChild($wishlistToggle);
          ctx.replaceWith(actionsWrapper);
        },
      },
    })($productList),
  ]);

  // Listen for search results (event is fired before the block is rendered; eager: true)
  events.on('search/result', (payload) => {
    const totalCount = payload.result?.totalCount || 0;

    block.classList.toggle('product-list-page--empty', totalCount === 0);

    // Results Info
    $resultInfo.innerHTML = payload.request?.phrase
      ? `${totalCount} results found for <strong>"${payload.request.phrase}"</strong>.`
      : `${totalCount} results found.`;

    // Update the view facets button with the number of filters
    if (payload.request.filter.length > 0) {
      $viewFacets.querySelector('button').setAttribute('data-count', payload.request.filter.length);
    } else {
      $viewFacets.querySelector('button').removeAttribute('data-count');
    }
  }, { eager: true });

  // Listen for search results (event is fired after the block is rendered; eager: false)
  // URL is owned by this project; update it when search state changes.
  events.on('search/result', (payload) => {
    const url = new URL(window.location.href);
    applySearchStateToUrl(url, payload.request);
    window.history.pushState({}, '', url.toString());
  }, { eager: false });
}
