import PageHeader from "../components/PageHeader";
import { ImageMagicIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { mapLimit, headSizeMB, optimizeBatch } from '../optimize.server';
import { PixelMeter } from '../components/Pixels';
import { fetchAllProducts, imageNodes, parseSummary, MAX_MEDIA_PER_PRODUCT } from '../catalog.server';
import {
  Page,
  Layout,
  Button,
  Badge,
  Checkbox,
  Text,
  Box,
  Thumbnail,
  Banner,
  Select,
  EmptyState
} from '@shopify/polaris';

/* -------------------------------------------------------------------------- */
/*  Product fetching (loader only)                                            */
/* -------------------------------------------------------------------------- */

// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + featuredMedia 3 + media(2 + 40×2) + summary 1 = 87, × 10 products ≈ 875.
const PRODUCTS_QUERY = `#graphql
  query OptimizerProducts($cursor: String) {
    products(first: 10, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        featuredMedia { preview { image { url } } }
        media(first: ${MAX_MEDIA_PER_PRODUCT}) {
          nodes { ... on MediaImage { id alt image { url } } }
        }
        summary: metafield(namespace: "image_optimization", key: "optimization_summary") { value }
      }
    }
  }
`;

/* -------------------------------------------------------------------------- */
/*  Loader                                                                    */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  // Plan, usage and per-shop settings drive the quota meter + auto-optimize UI.
  let plan = null;
  try {
    const state = await getBillingStateCached(admin, session.shop);
    plan = state.plan;
  } catch { /* fall through to Free defaults below */ }
  let usage = { period: '', imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready yet — default to zero/off */ }
  const planInfo = {
    tier: plan?.tier || 'free',
    name: plan?.name || 'Free',
    monthlyImages: plan?.monthlyImages ?? 100,
    autoOptimizeAllowed: entitled(plan, 'autoOptimize'),
  };

  try {
    const { products } = await fetchAllProducts(admin, PRODUCTS_QUERY);

    // Build a flat list of images we need to measure (only for products that
    // have never been optimized — optimized products carry totals in their
    // summary metafield). Measured with bounded concurrency + IPv4 so the page
    // loads in a few seconds instead of stalling on per-image connect timeouts.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const img of imageNodes(product)) {
        measureTasks.push({ productId: product.id, url: img.image.url });
      }
    }
    const measuredSizes = await mapLimit(measureTasks, 24, t => headSizeMB(t.url));
    const measuredByProduct = {};
    measureTasks.forEach((t, i) => {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (measuredSizes[i] || 0);
    });

    const processedProducts = products.map((product) => {
      const images = imageNodes(product);
      // The optimizer writes the summary on every batch, so a product without
      // one has not been processed yet. Its totalImages is the full count —
      // more accurate than the listing, which is capped at MAX_MEDIA_PER_PRODUCT.
      const summary = parseSummary(product);
      const imageCount = Math.max(images.length, summary?.totalImages || 0);
      const imagesWithAlt = images.filter(img => img.alt && img.alt.length > 10).length;
      let processed = summary ? (summary.optimizedImages || 0) : 0;
      processed = Math.min(processed, imageCount);

      let totalOriginalSize;
      let totalOptimizedSize;
      if (summary) {
        totalOriginalSize = summary.totalOriginalSizeMB || 0;
        totalOptimizedSize = summary.totalOptimizedSizeMB || 0;
      } else {
        totalOriginalSize = measuredByProduct[product.id] || 0;
        totalOptimizedSize = totalOriginalSize; // nothing saved yet
      }

      const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
      const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
      const compressionRate = totalOriginalSize > 0
        ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
        : 0;

      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        imageCount,
        imagesWithAlt,
        optimizedImages: processed,
        score,
        totalOriginalSizeMB: totalOriginalSize,
        totalOptimizedSizeMB: totalOptimizedSize,
        sizeSavedMB,
        compressionRate,
        featuredImageUrl: product.featuredMedia?.preview?.image?.url || images[0]?.image.url,
        needsOptimization: score < 100,
      };
    });

    // Return ALL products; filtering/sorting happens instantly on the client
    // from this list, so changing a filter never re-runs this (heavy) loader.
    return {
      products: processedProducts,
      filter,
      sortBy,
      plan: planInfo,
      usage,
      autoOptimize,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((s, p) => s + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((s, p) => s + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((s, p) => s + p.sizeSavedMB, 0),
      },
      error: null,
    };
  } catch (error) {
    console.error('Error loading products:', error);
    return {
      products: [],
      filter,
      sortBy,
      plan: planInfo,
      usage,
      autoOptimize,
      stats: { total: 0, needsOptimization: 0, optimized: 0, totalImages: 0, totalSizeMB: 0, potentialSavingsMB: 0 },
      error: 'Failed to load products',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Action — toggles auto-optimize, or processes ONE optimization batch       */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'setAutoOptimize') {
    const enabled = formData.get('enabled') === 'true';
    // Enabling is gated by plan entitlement; disabling is always allowed.
    if (enabled) {
      try {
        const { plan } = await getBillingStateCached(admin, session.shop);
        if (!entitled(plan, 'autoOptimize')) {
          return { success: false, settingUpdated: true, error: 'Autopilot is included with Growth and Pro.' };
        }
      } catch { /* if billing check fails, fall through and block enabling */
        return { success: false, settingUpdated: true, error: 'Could not verify your plan. Try again.' };
      }
    }
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, autoOptimize: enabled },
      update: { autoOptimize: enabled },
    });
    return { success: true, settingUpdated: true, autoOptimize: enabled };
  }

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      const { plan } = await getBillingStateCached(admin, session.shop);
      const remainingQuota = await getRemaining(session.shop, plan);
      return await optimizeBatch(admin, productId, {
        shop: session.shop,
        remainingQuota,
        genAlt: entitled(plan, 'altText'),
      });
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductOptimization() {
  const {
    products, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError,
    plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  const fetcher = useFetcher();
  const settingsFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // Live per-product progress, keyed by product id, updated after every batch.
  const [liveProgress, setLiveProgress] = useState({});
  const [activeId, setActiveId] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);
  const lastOptimizedRef = useRef({}); // productId -> optimized count last seen

  const startNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      activeRef.current = null;
      setActiveId(null);
      // Quietly re-run the loader in place (no full-page reload). The live
      // numbers in liveProgress remain authoritative for display, so stale
      // read-after-write metafield lag can't flip a finished product back to
      // "needs optimization".
      revalidator.revalidate();
      return;
    }
    activeRef.current = next;
    setActiveId(next);
    fetcher.submit({ actionType: 'optimizeProduct', productId: next }, { method: 'post' });
  }, [fetcher, revalidator]);

  // Drive the batch loop: each completed batch either continues the same
  // product or advances to the next queued product.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const data = fetcher.data;
    if (!data.productId || data.productId !== activeRef.current) return;

    if (data.success === false) {
      setError(data.error || 'Optimization failed');
      startNext();
      return;
    }

    setLiveProgress(prev => ({ ...prev, [data.productId]: data }));

    // Increment the session usage meter by the newly-optimized image delta.
    const prevSeen = lastOptimizedRef.current[data.productId] || 0;
    const delta = Math.max(0, (data.optimized || 0) - prevSeen);
    if (delta > 0) {
      lastOptimizedRef.current[data.productId] = data.optimized;
      setSessionImages(s => s + delta);
    }

    // Monthly quota hit — stop the whole queue and prompt to upgrade.
    if (data.quotaExceeded) {
      setError('You have used this month’s compression credits. Upgrade your plan to keep going.');
      queueRef.current = [];
      startNext();
      return;
    }

    if (data.done) {
      setSuccessMessage(data.message);
      setTimeout(() => setSuccessMessage(null), 4000);
      startNext();
    } else if (!data.advanced) {
      // A whole batch failed (e.g. unreachable images) — stop to avoid looping.
      setError(`Some images for "${data.title}" couldn't be processed (${data.remaining} remaining). Try again.`);
      startNext();
    } else {
      fetcher.submit({ actionType: 'optimizeProduct', productId: data.productId }, { method: 'post' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Reflect the saved auto-optimize setting (or surface a gating error).
  useEffect(() => {
    if (settingsFetcher.state !== 'idle' || !settingsFetcher.data) return;
    const d = settingsFetcher.data;
    if (!d.settingUpdated) return;
    if (d.success) {
      setAutoOptimize(d.autoOptimize);
    } else {
      setError(d.error || 'Could not update setting.');
      setAutoOptimize(false); // revert optimistic flip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFetcher.state, settingsFetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || activeRef.current) return;
    setError(null);
    queueRef.current = [...ids];
    startNext();
  }, [startNext]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleFilterChange = useCallback((value) => setFilter(value), []);
  const handleSortChange = useCallback((value) => setSortBy(value), []);

  const handleToggleAutoOptimize = useCallback((checked) => {
    setAutoOptimize(checked); // optimistic
    setError(null);
    settingsFetcher.submit(
      { actionType: 'setAutoOptimize', enabled: String(checked) },
      { method: 'post' }
    );
  }, [settingsFetcher]);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isBusy = activeId !== null;

  // Usage meter: loader baseline + images optimized live this session.
  const quota = plan?.monthlyImages ?? 100;
  const usedImages = (usage?.imagesUsed ?? 0) + sessionImages;
  const usagePct = quota > 0 ? Math.min(100, Math.round((usedImages / quota) * 100)) : 0;
  const quotaReached = usedImages >= quota;

  const formatBytes = (mb) => {
    const v = mb || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
    if (v >= 1) return `${v.toFixed(1)} MB`;
    if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
    return `0 KB`;
  };

  const filterOptions = [
    { label: 'All', value: 'all' },
    { label: 'To do', value: 'needs_optimization' },
    { label: 'Done', value: 'optimized' },
    { label: 'Missing alt', value: 'no_alt_text' },
  ];
  const sortOptions = [
    { label: 'Least compressed', value: 'score_asc' },
    { label: 'Most compressed', value: 'score_desc' },
    { label: 'Heaviest first', value: 'size_desc' },
    { label: 'Most photos first', value: 'images_desc' },
  ];

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  const filterCounts = {
    all: products.length,
    needs_optimization: products.filter(p => view(p).needsOptimization).length,
    optimized: products.filter(p => !view(p).needsOptimization).length,
    no_alt_text: products.filter(p => p.imagesWithAlt === 0).length,
  };
  const allSelected = selectedProducts.length === displayedProducts.length && displayedProducts.length > 0;

  const kpis = [
    { label: 'Products in catalog', value: stats.total.toLocaleString() },
    { label: 'Waiting to compress', value: stats.needsOptimization.toLocaleString(), tone: stats.needsOptimization > 0 ? 'warn' : undefined },
    { label: 'Product photos', value: stats.totalImages.toLocaleString() },
    { label: 'Weight removed', value: formatBytes(liveSavings), tone: 'good' },
  ];

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader icon={ImageMagicIcon} eyebrow="Compress" title="Image compression" subtitle="Turn heavy product photos into lean WebP files, swapped in place on each product" />
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
          </Layout.Section>
        )}

        {/* KPI strip */}
        <Layout.Section>
          <div className="pp-kpis">
            {kpis.map(k => (
              <div key={k.label} className="pp-kpi">
                <p className={`pp-kpi-value${k.tone ? ` pp-kpi-${k.tone}` : ''}`}>{k.value}</p>
                <p className="pp-kpi-label">{k.label}</p>
              </div>
            ))}
          </div>
        </Layout.Section>

        {/* Sidebar: usage + automation */}
        <Layout.Section variant="oneThird">
          <div className="pp-side-card">
            <div className="pp-side-block">
              <div className="pp-side-row">
                <span className="pp-side-title">Credits this month</span>
                <Badge tone={plan?.tier === 'free' ? undefined : 'success'}>{`${plan?.name || 'Free'} plan`}</Badge>
              </div>
              <p className="pp-side-big">
                {usedImages.toLocaleString()}
                <span>{` / ${quota.toLocaleString()}`}</span>
              </p>
              <PixelMeter pct={usagePct} light label={`${usagePct}% of monthly credits used`} />
              {quotaReached && (
                <Text variant="bodySm" as="p" tone="critical">
                  You have used this month's credits. Upgrade for more.
                </Text>
              )}
            </div>
            <div className="pp-side-block">
              <div className="pp-side-row">
                <span className="pp-side-title">Autopilot</span>
                {plan?.autoOptimizeAllowed
                  ? <Badge tone={autoOptimize ? 'success' : undefined}>{autoOptimize ? 'On' : 'Off'}</Badge>
                  : <Badge tone="attention">Growth+</Badge>}
              </div>
              <p className="pp-side-note">Compress photos on every new product automatically, in the background.</p>
              {plan?.autoOptimizeAllowed ? (
                <Checkbox
                  label="Run Autopilot on new products"
                  checked={autoOptimize}
                  onChange={handleToggleAutoOptimize}
                  disabled={settingsFetcher.state !== 'idle'}
                />
              ) : (
                <Text variant="bodySm" as="p" tone="subdued">Included with Growth and Pro.</Text>
              )}
            </div>
          </div>
        </Layout.Section>

        {/* Product list */}
        <Layout.Section>
          <div className="pp-list">
            <div className="pp-toolbar">
              <div className="pp-tabs" role="tablist" aria-label="Filter products">
                {filterOptions.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === o.value}
                    className={`pp-tab${filter === o.value ? ' is-active' : ''}`}
                    onClick={() => handleFilterChange(o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                    <span className="pp-tab-count">{filterCounts[o.value]}</span>
                  </button>
                ))}
              </div>
              <Box width="210px">
                <Select label="Sort by" labelInline options={sortOptions} value={sortBy} onChange={handleSortChange} disabled={isBusy} />
              </Box>
            </div>

            <div className="pp-row pp-row-head">
              <Checkbox
                label="Select all"
                labelHidden
                checked={allSelected}
                onChange={handleSelectAll}
                disabled={isBusy || displayedProducts.length === 0}
              />
              <span />
              <span>Product</span>
              <span>Progress</span>
              <span>Removed</span>
              <span>Done</span>
              <span />
            </div>

            {displayedProducts.length === 0 ? (
              <EmptyState heading="Nothing here yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>No products match this view. Try another tab.</p>
              </EmptyState>
            ) : (
              displayedProducts.map((raw) => {
                const product = view(raw);
                const isActive = activeId === product.id;
                const selected = selectedProducts.includes(product.id);
                const scoreTone = product.score >= 80 ? 'good' : product.score >= 60 ? 'warn' : 'bad';
                return (
                  <div key={product.id} className={`pp-row${selected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}>
                    <Checkbox
                      label={`Select ${product.title}`}
                      labelHidden
                      checked={selected}
                      onChange={() => handleSelectProduct(product.id)}
                      disabled={isBusy}
                    />
                    <Thumbnail source={product.featuredImageUrl || ImageMagicIcon} alt={product.title} size="small" />
                    <div className="pp-row-main">
                      <p className="pp-row-title">{product.title}</p>
                      <p className="pp-row-meta">
                        {`${product.status.toLowerCase()} · ${product.imageCount} images · alt text ${product.imagesWithAlt}/${product.imageCount}`}
                        {isActive && <span className="pp-live">Compressing</span>}
                      </p>
                    </div>
                    <div className="pp-row-progress">
                      <span>{`${product.optimizedImages}/${product.imageCount}`}</span>
                      <div className="pp-bar"><i style={{ width: `${product.score}%` }} /></div>
                    </div>
                    <div className="pp-row-saved">
                      <strong>{formatBytes(product.sizeSavedMB)}</strong>
                      <span>{`of ${formatBytes(product.totalOriginalSizeMB)}`}</span>
                    </div>
                    <div className={`pp-score pp-score-${scoreTone}`}>
                      {`${product.score}%`}
                    </div>
                    <div className="pp-row-action">
                      {product.needsOptimization ? (
                        <Button size="slim" variant="primary" onClick={() => handleOptimizeProduct(product.id)} loading={isActive} disabled={isBusy || quotaReached}>
                          Compress
                        </Button>
                      ) : (
                        <Badge tone="success">Compressed</Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Layout.Section>
      </Layout>

      {selectedProducts.length > 0 && (
        <div className="pp-bulkbar" role="region" aria-label="Bulk actions">
          <span>{`${selectedProducts.length} product${selectedProducts.length === 1 ? '' : 's'} selected`}</span>
          <div className="pp-bulkbar-actions">
            <button type="button" className="pp-btn pp-btn-glass" onClick={() => setSelectedProducts([])} disabled={isBusy}>Clear</button>
            <button type="button" className="pp-btn pp-btn-white" onClick={handleOptimizeSelected} disabled={isBusy || quotaReached}>
              {isBusy ? 'Compressing…' : 'Compress selected'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
