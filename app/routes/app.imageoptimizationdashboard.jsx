import PageHeader from "../components/PageHeader";
import { ChartVerticalIcon } from "@shopify/polaris-icons";
import { useState, useCallback } from 'react';
import { useLoaderData, useSubmit } from 'react-router';
import { authenticate } from '../shopify.server';
import {
  Page,
  Layout,
  Card,
  Select,
  Text,
  Box,
  InlineStack,
  BlockStack,
  ProgressBar,
  Badge,
  DataTable,
  Banner
} from '@shopify/polaris';

/**
 * Helper function to calculate date ranges
 */
function getDateRange(timeRange) {
  const now = new Date();
  const date = new Date(now);
  
  switch(timeRange) {
    case '7days':
      date.setDate(date.getDate() - 7);
      break;
    case '30days':
      date.setDate(date.getDate() - 30);
      break;
    case '90days':
      date.setDate(date.getDate() - 90);
      break;
    case 'all':
      date.setFullYear(2020, 0, 1);
      break;
    default:
      date.setDate(date.getDate() - 30);
  }
  
  return date;
}

/**
 * Fetch all products with pagination
 */
async function fetchAllProducts(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            images(first: 250) {
              edges {
                node {
                  id
                  url
                  altText
                  width
                  height
                }
              }
            }
            metafields(first: 20, namespace: "image_optimization") {
              edges {
                node {
                  key
                  value
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { cursor }
  });

  return await response.json();
}

async function getAllProducts(admin) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await fetchAllProducts(admin, cursor);
    const products = data.data.products.edges.map(edge => edge.node);
    allProducts = [...allProducts, ...products];

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return allProducts;
}

/**
 * Get image format from URL
 */
function getImageFormat(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.webp')) return 'WebP';
  if (urlLower.includes('.png')) return 'PNG';
  if (urlLower.includes('.gif')) return 'GIF';
  if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return 'JPEG';
  return 'JPEG';
}

/**
 * Process products data into metrics. Only the sizes measured by the optimizer
 * (stored on per-image metafields) are counted — no estimated sizes, so every
 * number shown to the merchant reflects actual before/after file sizes.
 */
function processProductsData(products, timeRange) {
  const startDate = getDateRange(timeRange);

  let totalImages = 0;
  let optimizedImages = 0;
  let totalOriginalSizeMB = 0;
  let totalOptimizedSizeMB = 0;
  let formatStats = {};
  let recentActivityMap = {};
  let pageStats = [];

  products.forEach(product => {
    const images = product.images.edges.map(edge => edge.node);
    const productUrl = `/products/${product.handle}`;

    let pageImageCount = 0;
    let pageSizeSaved = 0;
    let pageOriginalSize = 0;

    images.forEach(image => {
      totalImages++;

      const format = getImageFormat(image.url);
      if (!formatStats[format]) {
        formatStats[format] = {
          format,
          count: 0,
          originalSizeMB: 0,
          optimizedSizeMB: 0
        };
      }
      formatStats[format].count++;

      const imageKey = `image_${image.id.split('/').pop()}`;
      const optimizationData = product.metafields.edges.find(
        edge => edge.node.key === imageKey
      );

      if (!optimizationData) return;

      try {
        const optData = JSON.parse(optimizationData.node.value);
        if (typeof optData.originalSizeMB !== 'number' || typeof optData.optimizedSizeMB !== 'number') {
          return;
        }

        const originalSizeMB = optData.originalSizeMB;
        const optimizedSizeMB = optData.optimizedSizeMB;
        const updatedAt = new Date(optData.optimizedAt || optimizationData.node.updatedAt);

        if (updatedAt < startDate) return;

        optimizedImages++;
        totalOriginalSizeMB += originalSizeMB;
        totalOptimizedSizeMB += optimizedSizeMB;
        formatStats[format].originalSizeMB += originalSizeMB;
        formatStats[format].optimizedSizeMB += optimizedSizeMB;

        pageImageCount++;
        pageSizeSaved += (originalSizeMB - optimizedSizeMB);
        pageOriginalSize += originalSizeMB;

        const dateKey = updatedAt.toISOString().split('T')[0];
        if (!recentActivityMap[dateKey]) {
          recentActivityMap[dateKey] = {
            date: dateKey,
            imagesOptimized: 0,
            sizeSavedMB: 0,
            totalOriginalMB: 0,
            totalOptimizedMB: 0
          };
        }

        recentActivityMap[dateKey].imagesOptimized++;
        recentActivityMap[dateKey].sizeSavedMB += (originalSizeMB - optimizedSizeMB);
        recentActivityMap[dateKey].totalOriginalMB += originalSizeMB;
        recentActivityMap[dateKey].totalOptimizedMB += optimizedSizeMB;
      } catch (e) {
        // Unreadable optimization record — leave the image out of the totals.
      }
    });

    if (pageImageCount > 0) {
      const sizeReductionPercent = pageOriginalSize > 0
        ? Math.min(Math.round((pageSizeSaved / pageOriginalSize) * 100), 100)
        : 0;

      let impact = 'low';
      if (pageSizeSaved > 2.5) impact = 'high';
      else if (pageSizeSaved > 1) impact = 'medium';

      pageStats.push({
        url: productUrl,
        productTitle: product.title,
        imagesCount: pageImageCount,
        sizeSavedMB: pageSizeSaved,
        sizeReductionPercent,
        impact
      });
    }
  });

  const totalSavingsMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const avgCompressionRate = totalOriginalSizeMB > 0
    ? Math.round((totalSavingsMB / totalOriginalSizeMB) * 100)
    : 0;

  const recentActivity = Object.values(recentActivityMap)
    .map(day => ({
      ...day,
      compressionRate: day.totalOriginalMB > 0
        ? Math.round(((day.totalOriginalMB - day.totalOptimizedMB) / day.totalOriginalMB) * 100)
        : 0
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  const topPages = pageStats
    .sort((a, b) => b.sizeSavedMB - a.sizeSavedMB)
    .slice(0, 10);

  return {
    metrics: {
      totalImages,
      optimizedImages,
      totalSavingsMB,
      totalOriginalSizeMB,
      totalOptimizedSizeMB,
      avgCompressionRate
    },
    byFormat: Object.values(formatStats).sort((a, b) => b.count - a.count),
    recentActivity,
    topPages
  };
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const timeRange = url.searchParams.get('timeRange') || '30days';

  try {
    const products = await getAllProducts(admin);
    const { metrics, byFormat, recentActivity, topPages } = processProductsData(products, timeRange);

    return { 
      metrics, 
      byFormat, 
      recentActivity, 
      topPages, 
      timeRange,
      error: null 
    };
  } catch (error) {
    console.error('Error loading dashboard data:', error);
    return {
      metrics: {
        totalImages: 0,
        optimizedImages: 0,
        totalSavingsMB: 0,
        totalOriginalSizeMB: 0,
        totalOptimizedSizeMB: 0,
        avgCompressionRate: 0
      },
      byFormat: [],
      recentActivity: [],
      topPages: [],
      timeRange,
      error: 'Failed to load dashboard data'
    };
  }
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'exportReport') {
    const timeRange = formData.get('timeRange');
    
    try {
      const products = await getAllProducts(admin);
      const { metrics, byFormat, recentActivity, topPages } = processProductsData(products, timeRange);

      const csvRows = [
        ['Image Optimization Report'],
        ['Generated:', new Date().toLocaleString()],
        ['Time Range:', timeRange],
        [''],
        ['Overview Metrics'],
        ['Metric', 'Value'],
        ['Total Images', metrics.totalImages],
        ['Optimized Images', metrics.optimizedImages],
        ['Optimization Rate', `${Math.round((metrics.optimizedImages / Math.max(metrics.totalImages, 1)) * 100)}%`],
        ['Measured Original Size (MB)', metrics.totalOriginalSizeMB.toFixed(2)],
        ['Measured Optimized Size (MB)', metrics.totalOptimizedSizeMB.toFixed(2)],
        ['Total Savings (MB)', metrics.totalSavingsMB.toFixed(2)],
        ['Average Compression Rate', `${metrics.avgCompressionRate}%`],
        [''],
        ['Format Breakdown'],
        ['Format', 'Count', 'Original Size (MB)', 'Optimized Size (MB)', 'Savings (MB)', 'Compression Rate'],
        ...byFormat.map(f => [
          f.format,
          f.count,
          f.originalSizeMB.toFixed(2),
          f.optimizedSizeMB.toFixed(2),
          (f.originalSizeMB - f.optimizedSizeMB).toFixed(2),
          `${Math.round(((f.originalSizeMB - f.optimizedSizeMB) / f.originalSizeMB) * 100)}%`
        ]),
        [''],
        ['Recent Activity'],
        ['Date', 'Images Optimized', 'Size Saved (MB)', 'Compression Rate'],
        ...recentActivity.map(a => [
          new Date(a.date).toLocaleDateString(),
          a.imagesOptimized,
          a.sizeSavedMB.toFixed(2),
          `${a.compressionRate}%`
        ]),
        [''],
        ['Top Optimized Pages'],
        ['Product', 'URL', 'Images', 'Size Saved (MB)', 'Size Reduction', 'Impact'],
        ...topPages.map(p => [
          p.productTitle || 'Unknown',
          p.url,
          p.imagesCount,
          p.sizeSavedMB.toFixed(2),
          `${p.sizeReductionPercent}%`,
          p.impact.toUpperCase()
        ])
      ];

      const csv = csvRows.map(row => 
        row.map(cell => 
          typeof cell === 'string' && cell.includes(',') ? `"${cell}"` : cell
        ).join(',')
      ).join('\n');
      
      return { 
        success: true, 
        csv,
        filename: `image-optimization-report-${timeRange}-${Date.now()}.csv`
      };
    } catch (error) {
      console.error('Error generating report:', error);
      return { success: false, error: 'Failed to generate report' };
    }
  }

  return { success: false, error: 'Invalid action' };
}

export default function ImageOptimizationDashboard() {
  const { 
    metrics, 
    byFormat, 
    recentActivity, 
    topPages, 
    timeRange: initialTimeRange,
    error: loadError 
  } = useLoaderData();
  
  const submit = useSubmit();
  const [timeRange, setTimeRange] = useState(initialTimeRange);

  const handleTimeRangeChange = useCallback((value) => {
    setTimeRange(value);
    submit({ timeRange: value }, { method: 'get' });
  }, [submit]);

  const handleExportReport = useCallback(() => {
    const formData = new FormData();
    formData.append('actionType', 'exportReport');
    formData.append('timeRange', timeRange);
    submit(formData, { method: 'post' });
  }, [timeRange, submit]);

  const calculatePercentage = (value, total) => {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
  };

  const formatBytes = (mb) => {
    if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(mb * 1024).toFixed(0)} KB`;
  };

  const timeRangeOptions = [
    { label: 'Last 7 days', value: '7days' },
    { label: 'Last 30 days', value: '30days' },
    { label: 'Last 90 days', value: '90days' },
    { label: 'All time', value: 'all' }
  ];

  const getImpactBadge = (impact) => {
    switch (impact?.toLowerCase()) {
      case 'high': return <Badge tone="success">High Impact</Badge>;
      case 'medium': return <Badge tone="attention">Medium Impact</Badge>;
      case 'low': return <Badge tone="info">Low Impact</Badge>;
      default: return <Badge>Unknown</Badge>;
    }
  };

  const topPagesRows = topPages.map((page) => [
    page.url,
    page.imagesCount?.toString() || '0',
    formatBytes(page.sizeSavedMB || 0),
    `${page.sizeReductionPercent || 0}%`,
    getImpactBadge(page.impact)
  ]);

  const optimizationRate = calculatePercentage(metrics.optimizedImages, metrics.totalImages);

  return (
    <Page
      title="Optimization Analytics"
      subtitle="Measured results from your image optimization runs"
      primaryAction={{ 
        content: 'Export Report', 
        onAction: handleExportReport 
      }}
      secondaryActions={[
        {
          content: 'Optimize Products',
          url: '/app/product-optimization'
        }
      ]}
    >
      <Layout>
        <Layout.Section>
          <PageHeader icon={ChartVerticalIcon} eyebrow="Analytics" title="Optimization Analytics" subtitle="Size savings, compression rates & format breakdown" />
        </Layout.Section>
        {loadError && (
          <Layout.Section>
            <Banner title="Error" tone="critical">
              {loadError}
            </Banner>
          </Layout.Section>
        )}

        {metrics.totalImages === 0 && (
          <Layout.Section>
            <Banner title="Get Started" tone="info">
              <p>Start optimizing your product images to see detailed analytics and performance metrics.</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Time Range Selector */}
        <Layout.Section>
          <Box paddingBlockEnd="400">
            <InlineStack align="end">
              <Box width="200px">
                <Select 
                  label="Time range" 
                  options={timeRangeOptions} 
                  value={timeRange} 
                  onChange={handleTimeRangeChange} 
                />
              </Box>
            </InlineStack>
          </Box>
        </Layout.Section>

        {/* Key Metrics */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <Text variant="bodyMd" as="p" tone="subdued">Total Images</Text>
                  <Text variant="heading2xl" as="h2">{metrics.totalImages.toLocaleString()}</Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" as="p" tone="success">
                      {metrics.optimizedImages.toLocaleString()} optimized
                    </Text>
                    <Badge tone={optimizationRate >= 80 ? 'success' : optimizationRate >= 50 ? 'attention' : 'critical'}>
                      {optimizationRate}%
                    </Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Box>

            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <Text variant="bodyMd" as="p" tone="subdued">Total Size Saved</Text>
                  <Text variant="heading2xl" as="h2">{formatBytes(metrics.totalSavingsMB)}</Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    Avg compression: <Text as="span" tone="success" fontWeight="semibold">{metrics.avgCompressionRate}%</Text>
                  </Text>
                </BlockStack>
              </Card>
            </Box>

            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <Text variant="bodyMd" as="p" tone="subdued">Image Payload (Measured)</Text>
                  <Text variant="heading2xl" as="h2">
                    {formatBytes(metrics.totalOriginalSizeMB)} → {formatBytes(metrics.totalOptimizedSizeMB)}
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    Before → after file sizes of optimized images
                  </Text>
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        {/* Format Breakdown and Recent Activity */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="50%">
              <Card>
                <BlockStack gap="500">
                  <Text variant="headingMd" as="h3">Optimization by Format</Text>
                  {byFormat.length === 0 ? (
                    <Box padding="800">
                      <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                        No data available
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="400">
                      {byFormat.map((format) => {
                        const savings = format.originalSizeMB - format.optimizedSizeMB;
                        const compressionPercent = format.originalSizeMB > 0
                          ? Math.round((savings / format.originalSizeMB) * 100)
                          : 0;
                        
                        return (
                          <Box key={format.format}>
                            <BlockStack gap="300">
                              <InlineStack align="space-between">
                                <InlineStack gap="200">
                                  <Text variant="bodyMd" as="p" fontWeight="semibold">{format.format}</Text>
                                  <Text variant="bodyMd" as="p" tone="subdued">({format.count} images)</Text>
                                </InlineStack>
                                <Text variant="bodyMd" as="p" tone="success" fontWeight="semibold">
                                  -{formatBytes(savings)}
                                </Text>
                              </InlineStack>
                              <ProgressBar
                                progress={compressionPercent}
                                size="small"
                                tone="success"
                              />
                              <Text variant="bodySm" as="p" tone="subdued" alignment="end">
                                {compressionPercent}% reduction
                              </Text>
                            </BlockStack>
                          </Box>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Box>

            <Box width="50%">
              <Card>
                <BlockStack gap="500">
                  <Text variant="headingMd" as="h3">Recent Activity</Text>
                  {recentActivity.length === 0 ? (
                    <Box padding="800">
                      <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                        No recent activity
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="300">
                      {recentActivity.map((day, index) => (
                        <Box key={index} background="bg-surface-secondary" padding="400" borderRadius="200">
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="100">
                              <Text variant="bodyMd" as="p" fontWeight="semibold">
                                {day.imagesOptimized} images optimized
                              </Text>
                              <Text variant="bodySm" as="p" tone="subdued">
                                {new Date(day.date).toLocaleDateString()}
                              </Text>
                            </BlockStack>
                            <BlockStack gap="100" inlineAlign="end">
                              <Text variant="bodyMd" as="p" tone="success" fontWeight="bold">
                                {formatBytes(day.sizeSavedMB)}
                              </Text>
                              <Text variant="bodySm" as="p" tone="subdued">{day.compressionRate}% compression</Text>
                            </BlockStack>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        {/* Top Pages Table */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Top Optimized Pages</Text>
              {topPages.length === 0 ? (
                <Box padding="800">
                  <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                    No data available
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'numeric', 'text', 'text', 'text']}
                  headings={['Page URL', 'Images', 'Size Saved', 'Size Reduction', 'Impact']}
                  rows={topPagesRows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}