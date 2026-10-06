import PageHeader from "../components/PageHeader";
import { GaugeIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useEffect } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData, redirect } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { entitled } from '../plans.server';
import { fetchAllProducts, parseSummary } from '../catalog.server';

// Page Speed reports are a Growth+ feature. Resolve the shop's plan and return
// its entitlement; lets a Response (re-auth) propagate, treats any other failure
// as "not entitled" so the feature fails closed rather than leaking.
async function pageSpeedAllowed(admin, shop) {
  try {
    const { plan } = await getBillingStateCached(admin, shop);
    return entitled(plan, 'pageSpeed');
  } catch (e) {
    if (e instanceof Response) throw e;
    return false;
  }
}
import {
  Page,
  Layout,
  Card,
  Select,
  Text,
  Box,
  InlineStack,
  BlockStack,
  Badge,
  DataTable,
  Banner,
  Button
} from '@shopify/polaris';

// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + summary 1 = 2, × 100 products ≈ 202.
const PRODUCTS_QUERY = `#graphql
  query SpeedLabProducts($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        onlineStoreUrl
        summary: metafield(namespace: "image_optimization", key: "optimization_summary") { value }
      }
    }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One PSI attempt. Throws { retryable } so the caller can decide to retry.
async function pageSpeedAttempt(apiUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(apiUrl, { signal: controller.signal });
  } catch (e) {
    // Network error or our 45s abort — transient, worth retrying.
    const err = new Error(e?.name === 'AbortError' ? 'PageSpeed request timed out' : `PageSpeed network error: ${e?.message || e}`);
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error?.message || ''; } catch { /* non-JSON */ }
    const err = new Error(`PageSpeed API request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    // 429 (rate limit) and 5xx are transient; other 4xx (bad/unreachable URL) are not.
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  const lighthouseResult = data.lighthouseResult;
  if (!lighthouseResult) {
    // Sometimes PSI returns 200 with a lighthouse runtime error (e.g. page slow
    // to load) — treat as retryable, a re-run often succeeds.
    const err = new Error('No Lighthouse data in response');
    err.retryable = true;
    throw err;
  }

  const performanceScore = Math.round((lighthouseResult.categories.performance?.score || 0) * 100);
  const audits = lighthouseResult.audits;
  const lcpAudit = audits['largest-contentful-paint'];
  const tbtAudit = audits['total-blocking-time'];
  const clsAudit = audits['cumulative-layout-shift'];
  const ttfbAudit = audits['server-response-time'];
  const speedIndexAudit = audits['speed-index'];
  const interactiveAudit = audits['interactive'];

  return {
    score: performanceScore,
    lcp: lcpAudit?.numericValue ? parseFloat((lcpAudit.numericValue / 1000).toFixed(2)) : 0,
    tbt: tbtAudit?.numericValue ? Math.round(tbtAudit.numericValue) : 0,
    cls: clsAudit?.numericValue ? parseFloat(clsAudit.numericValue.toFixed(3)) : 0,
    ttfb: ttfbAudit?.numericValue ? parseFloat((ttfbAudit.numericValue / 1000).toFixed(2)) : 0,
    loadTime: interactiveAudit?.numericValue ? parseFloat((interactiveAudit.numericValue / 1000).toFixed(2)) : 0,
    speedIndex: speedIndexAudit?.numericValue ? parseFloat((speedIndexAudit.numericValue / 1000).toFixed(2)) : 0,
    timestamp: new Date().toISOString()
  };
}

/**
 * Run a real Lighthouse performance test via Google PageSpeed Insights API.
 * The keyless endpoint is rate-limited, so failures are often transient — we
 * retry with backoff (up to 3 attempts) on 429/5xx/timeout, which makes the
 * test reliable without requiring a GOOGLE_PAGESPEED_API_KEY (one still raises
 * the limits further if set). Returns null only after all attempts fail.
 */
async function runPageSpeedTest(url) {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const keyParam = apiKey ? `&key=${apiKey}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&strategy=mobile${keyParam}`;

  const backoffs = [0, 2000, 5000]; // before attempts 1, 2, 3
  let lastErr;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      return await pageSpeedAttempt(apiUrl);
    } catch (e) {
      lastErr = e;
      console.error(`PageSpeed attempt ${attempt + 1} failed:`, e?.message || e);
      if (!e?.retryable) break; // bad/unreachable URL — retrying won't help
    }
  }
  console.error('PageSpeed test failed after retries:', lastErr?.message || lastErr);
  return null;
}

/**
 * Read the real optimization results stored on the product's metafields
 * (written by the optimizer after actual compression runs).
 */
function getOptimizationData(product) {
  const data = parseSummary(product);
  if (!data) return null;
  return {
    totalSizeSavedMB: parseFloat((data.totalSizeSavedMB || 0).toFixed(2)),
    totalOriginalSizeMB: parseFloat((data.totalOriginalSizeMB || 0).toFixed(2)),
    totalOptimizedSizeMB: parseFloat((data.totalOptimizedSizeMB || 0).toFixed(2)),
    compressionRate: data.avgCompressionRate || 0,
    optimizedImages: data.optimizedImages || 0
  };
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: only Growth+ may view Page Speed reports. Others go back to
  // the app home (where they see their plan + an upgrade path).
  if (!(await pageSpeedAllowed(admin, session.shop))) throw redirect('/app');
  const url = new URL(request.url);
  const selectedPage = url.searchParams.get('page') || 'all';

  try {
    const { products } = await fetchAllProducts(admin, PRODUCTS_QUERY);

    const shop = session.shop;
    // Use the full myshopify domain — stripping ".myshopify.com" produced an
    // invalid host (e.g. "https://mystore") that PageSpeed could never load.
    // The myshopify URL is publicly reachable and redirects to the primary domain.
    const shopUrl = `https://${shop}`;

    const pages = [];

    for (const product of products) {
      const optimization = getOptimizationData(product);

      if (optimization && optimization.totalSizeSavedMB > 0) {
        pages.push({
          id: product.handle,
          url: `/products/${product.handle}`,
          fullUrl: product.onlineStoreUrl || `${shopUrl}/products/${product.handle}`,
          name: product.title,
          productId: product.id,
          optimization
        });
      }
    }

    const totalSaved = pages.reduce((sum, p) => sum + p.optimization.totalSizeSavedMB, 0);
    const totalOriginal = pages.reduce((sum, p) => sum + p.optimization.totalOriginalSizeMB, 0);
    const totalImages = pages.reduce((sum, p) => sum + p.optimization.optimizedImages, 0);
    const avgCompression = pages.length > 0
      ? pages.reduce((sum, p) => sum + p.optimization.compressionRate, 0) / pages.length
      : 0;

    const insights = [];

    if (totalSaved > 0) {
      insights.push({
        id: '1',
        type: 'success',
        title: 'Image Payload Reduced',
        description: `Total image payload reduced by ${totalSaved.toFixed(1)} MB across ${pages.length} product pages (${avgCompression.toFixed(0)}% average compression, ${totalImages} images optimized). These figures are measured from the actual file sizes before and after compression.`,
        impact: 'high',
        status: 'completed'
      });

      insights.push({
        id: '2',
        type: 'info',
        title: 'Smaller Images Generally Improve Core Web Vitals',
        description: 'Reducing image transfer size typically improves load time and Largest Contentful Paint, especially on mobile connections. To see the measured impact on your store, run a live PageSpeed test below — results vary by theme, hosting, and other page content.',
        impact: 'medium',
        status: 'pending'
      });
    }

    const unoptimizedCount = products.length - pages.length;
    if (unoptimizedCount > 0) {
      insights.push({
        id: '3',
        type: 'warning',
        title: 'Additional Optimization Opportunities',
        description: `${unoptimizedCount} product pages have not been optimized yet. Run image optimization on these pages to reduce their image payload as well.`,
        impact: 'medium',
        status: 'pending'
      });
    }

    insights.push({
      id: '4',
      type: 'info',
      title: 'Ongoing Performance Monitoring',
      description: 'Continue monitoring Core Web Vitals and run periodic optimizations as new products are added. Consider implementing lazy loading for below-the-fold images.',
      impact: 'low',
      status: 'pending'
    });

    return {
      pages,
      insights,
      selectedPage,
      shopUrl,
      totalProducts: products.length,
      optimizedProducts: pages.length,
      totalSavedMB: totalSaved,
      totalOriginalMB: totalOriginal,
      totalImagesOptimized: totalImages,
      avgCompression,
      error: null
    };
  } catch (error) {
    console.error('Error loading page speed data:', error);
    return {
      pages: [],
      insights: [{
        id: 'error',
        type: 'critical',
        title: 'Error Loading Data',
        description: error.message || 'Failed to load optimization data. Please try refreshing the page.',
        impact: 'high',
        status: 'error'
      }],
      selectedPage,
      shopUrl: '',
      totalProducts: 0,
      optimizedProducts: 0,
      totalSavedMB: 0,
      totalOriginalMB: 0,
      totalImagesOptimized: 0,
      avgCompression: 0,
      error: 'Failed to load optimization data'
    };
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: block report runs for non-entitled plans (defends the action
  // even if the UI were bypassed).
  if (!(await pageSpeedAllowed(admin, session.shop))) {
    return { error: 'Speed Lab is included with Growth and Pro.' };
  }
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'runLighthouseAnalysis') {
    const pageUrl = formData.get('pageUrl');
    const pageName = formData.get('pageName');

    try {
      const result = await runPageSpeedTest(pageUrl);

      if (!result) {
        throw new Error('Failed to run PageSpeed test');
      }

      return {
        success: true,
        message: `PageSpeed test completed for ${pageName || pageUrl}. Performance Score: ${result.score}/100`,
        pageUrl,
        pageName,
        result
      };
    } catch (error) {
      console.error('Error running PageSpeed analysis:', error);
      const detail = error?.message ? ` (${error.message})` : '';
      return {
        success: false,
        error: `Google PageSpeed couldn't analyze this page right now${detail}. This is usually temporary (Google rate limits) or because the page isn't publicly reachable yet (an unpublished or password-protected storefront). Your measured optimization savings below are unaffected — please try the live test again in a moment.`
      };
    }
  }

  return { success: false, error: 'Invalid action type' };
}

export default function PageSpeedImpactReports() {
  const {
    pages,
    insights,
    selectedPage: initialSelectedPage,
    totalProducts,
    optimizedProducts,
    totalSavedMB,
    totalImagesOptimized,
    avgCompression,
    error: loadError
  } = useLoaderData();

  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();

  const [selectedPage, setSelectedPage] = useState(
    initialSelectedPage !== 'all' && pages.some(p => p.id === initialSelectedPage)
      ? initialSelectedPage
      : (pages[0]?.id || '')
  );
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const isRunningAnalysis = navigation.state === 'submitting';

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccessBanner(true);
    }
  }, [actionData]);

  const handlePageChange = useCallback((value) => {
    setSelectedPage(value);
  }, []);

  const handleRunLighthouse = useCallback(() => {
    const currentPage = pages.find(p => p.id === selectedPage);
    if (!currentPage) return;

    const formData = new FormData();
    formData.append('actionType', 'runLighthouseAnalysis');
    formData.append('pageUrl', currentPage.fullUrl);
    formData.append('pageName', currentPage.name);
    submit(formData, { method: 'post' });
  }, [selectedPage, pages, submit]);

  const getScoreTone = (score) => {
    if (score >= 90) return 'success';
    if (score >= 50) return 'warning';
    return 'critical';
  };

  const getScoreLabel = (score) => {
    if (score >= 90) return 'Good';
    if (score >= 50) return 'Needs Improvement';
    return 'Poor';
  };

  const pageOptions = pages.map(page => ({ label: page.name || page.url, value: page.id }));

  const getInsightBadge = (impact, status) => {
    if (status === 'completed') return <Badge tone="success">Measured</Badge>;
    if (status === 'error') return <Badge tone="critical">Error</Badge>;
    switch (impact?.toLowerCase()) {
      case 'high': return <Badge tone="critical-strong">High Impact</Badge>;
      case 'medium': return <Badge tone="attention">Medium Impact</Badge>;
      case 'low': return <Badge tone="info">Low Impact</Badge>;
      default: return <Badge>Unknown</Badge>;
    }
  };

  const getInsightTone = (type) => {
    switch (type?.toLowerCase()) {
      case 'success': return 'success';
      case 'warning': return 'warning';
      case 'critical': return 'critical';
      case 'info': return 'info';
      default: return 'info';
    }
  };

  const liveResult = actionData?.success ? actionData.result : null;

  const liveMetricRows = liveResult ? [
    ['Performance Score', `${liveResult.score}/100`, getScoreLabel(liveResult.score)],
    ['Largest Contentful Paint (LCP)', `${liveResult.lcp}s`, liveResult.lcp <= 2.5 ? 'Good' : liveResult.lcp <= 4 ? 'Needs Improvement' : 'Poor'],
    ['Total Blocking Time (TBT)', `${liveResult.tbt}ms`, liveResult.tbt <= 200 ? 'Good' : liveResult.tbt <= 600 ? 'Needs Improvement' : 'Poor'],
    ['Cumulative Layout Shift (CLS)', `${liveResult.cls}`, liveResult.cls <= 0.1 ? 'Good' : liveResult.cls <= 0.25 ? 'Needs Improvement' : 'Poor'],
    ['Time to First Byte (TTFB)', `${liveResult.ttfb}s`, liveResult.ttfb <= 0.8 ? 'Good' : 'Needs Improvement'],
    ['Speed Index', `${liveResult.speedIndex}s`, liveResult.speedIndex <= 3.4 ? 'Good' : liveResult.speedIndex <= 5.8 ? 'Needs Improvement' : 'Poor'],
    ['Time to Interactive', `${liveResult.loadTime}s`, liveResult.loadTime <= 3.8 ? 'Good' : liveResult.loadTime <= 7.3 ? 'Needs Improvement' : 'Poor']
  ] : [];

  const pageTableRows = pages.slice(0, 20).map((page) => [
    <BlockStack key={`${page.id}-name`} gap="100">
      <Text variant="bodyMd" as="p" fontWeight="semibold">{page.name}</Text>
      <Text variant="bodySm" as="p" tone="subdued">{page.url}</Text>
    </BlockStack>,
    <Text key={`${page.id}-images`} variant="bodyMd" as="p">{page.optimization.optimizedImages}</Text>,
    <Text key={`${page.id}-before`} variant="bodyMd" as="p">{page.optimization.totalOriginalSizeMB.toFixed(2)} MB</Text>,
    <Text key={`${page.id}-after`} variant="bodyMd" as="p">{page.optimization.totalOptimizedSizeMB.toFixed(2)} MB</Text>,
    <Text key={`${page.id}-saved`} variant="bodyMd" as="p" tone="success" fontWeight="semibold">{page.optimization.totalSizeSavedMB.toFixed(2)} MB</Text>,
    <Badge key={`${page.id}-rate`} tone="success">{Math.round(page.optimization.compressionRate)}%</Badge>
  ]);

  return (
    <Page
    >
      <Layout>
        <Layout.Section>
          <PageHeader icon={GaugeIcon} eyebrow="Speed Lab" title="Storefront speed" subtitle="Real weight removed per page, plus on-demand Lighthouse tests" />
        </Layout.Section>
        {loadError && (
          <Layout.Section>
            <Banner title="Error" tone="critical">
              {loadError}
            </Banner>
          </Layout.Section>
        )}

        {actionData?.error && (
          <Layout.Section>
            <Banner title="Live test couldn't complete" tone="warning">
              {actionData.error}
            </Banner>
          </Layout.Section>
        )}

        {/* Stats Banner — measured optimization results */}
        <Layout.Section>
          <Banner tone="info">
            <BlockStack gap="200">
              <Text variant="bodyMd" as="p">
                <strong>{optimizedProducts}</strong> out of <strong>{totalProducts}</strong> product pages have been optimized.
              </Text>
              <Text variant="bodyMd" as="p">
                Measured savings: <strong>{totalSavedMB.toFixed(1)} MB</strong> across <strong>{totalImagesOptimized}</strong> images
                ({avgCompression.toFixed(0)}% average compression). These figures come from the actual file sizes before and after compression.
              </Text>
            </BlockStack>
          </Banner>
        </Layout.Section>

        {/* Live PageSpeed Test */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Run a Lighthouse test</Text>
              <Text variant="bodyMd" as="p">
                Run a real Lighthouse test via Google PageSpeed Insights to measure the current performance of a product page.
                This is actual measured data for your store, not an estimate.
              </Text>
              {pages.length > 0 ? (
                <InlineStack gap="400" blockAlign="end" wrap={true}>
                  <Box minWidth="300px">
                    <Select
                      label="Product page"
                      options={pageOptions}
                      value={selectedPage}
                      onChange={handlePageChange}
                    />
                  </Box>
                  <Button
                    variant="primary"
                    onClick={handleRunLighthouse}
                    loading={isRunningAnalysis}
                    disabled={isRunningAnalysis || !selectedPage}
                  >
                    {isRunningAnalysis ? 'Running test…' : 'Start test'}
                  </Button>
                </InlineStack>
              ) : (
                <Text variant="bodyMd" as="p" tone="subdued">
                  Optimize at least one product page first, then come back here to measure its performance.
                </Text>
              )}
              <Text variant="bodySm" as="p" tone="subdued">
                Tests run against the live page on Google's servers and may take 30–60 seconds. Rate limits apply.
                Tip: run a test before and after optimizing a page to see the measured difference.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Live test results */}
        {showSuccessBanner && liveResult && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h3">
                    Measured Results — {actionData.pageName || actionData.pageUrl}
                  </Text>
                  <Badge tone={getScoreTone(liveResult.score)}>
                    {`Score: ${liveResult.score}/100 (${getScoreLabel(liveResult.score)})`}
                  </Badge>
                </InlineStack>
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Metric', 'Measured Value', 'Rating']}
                  rows={liveMetricRows}
                />
                <Text variant="bodySm" as="p" tone="subdued">
                  Source: Google PageSpeed Insights (Lighthouse, mobile). Tested at {new Date(liveResult.timestamp).toLocaleString()}.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Page-by-Page measured savings */}
        {pages.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h3">Weight removed, page by page</Text>
                  {pages.length > 20 && (
                    <Badge tone="info">Showing first 20 of {pages.length} pages</Badge>
                  )}
                </InlineStack>
                <DataTable
                  columnContentTypes={['text', 'numeric', 'text', 'text', 'text', 'text']}
                  headings={['Page', 'Images', 'Before', 'After', 'Saved', 'Compression']}
                  rows={pageTableRows}
                />
                <Text variant="bodySm" as="p" tone="subdued">
                  File sizes are measured from your store's actual images before and after optimization.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Insights */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">What to do next</Text>
              {insights.map((insight) => (
                <Banner key={insight.id} tone={getInsightTone(insight.type)}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="start">
                      <Text variant="bodyMd" as="p" fontWeight="semibold">{insight.title}</Text>
                      {getInsightBadge(insight.impact, insight.status)}
                    </InlineStack>
                    <Text variant="bodyMd" as="p">{insight.description}</Text>
                  </BlockStack>
                </Banner>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
