import PageHeader from "../components/PageHeader";
import { MagicIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData, useFetcher, redirect } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { entitled } from '../plans.server';
import { setDefaultResultOrder } from 'node:dns';
import { fetchAllProducts, imageNodes, MAX_MEDIA_PER_PRODUCT } from '../catalog.server';

// AI alt text is a Starter+ feature. Returns whether the shop's plan includes it;
// lets a re-auth Response propagate, treats other failures as not-entitled.
async function altTextAllowed(admin, shop) {
  try {
    const { plan } = await getBillingStateCached(admin, shop);
    return entitled(plan, 'altText');
  } catch (e) {
    if (e instanceof Response) throw e;
    return false;
  }
}
import { 
  Page, 
  Layout, 
  Card, 
  Button, 
  TextField, 
  Badge, 
  Checkbox, 
  Text, 
  Box, 
  InlineStack, 
  BlockStack, 
  Thumbnail, 
  Divider, 
  Banner,
  Select,
  ProgressBar,
  Pagination
} from '@shopify/polaris';

const PAGE_SIZE = 20;

// How many images the client asks the server to caption per request. Small
// batches keep every request short (a few seconds) so they never hit a proxy
// or browser timeout — the client drives the loop and shows live progress.
const GEN_BATCH_SIZE = 5;

// Prefer IPv4 + cap every upstream call so a slow OpenAI/Anthropic/CDN response
// can never stall a request indefinitely (the old monolithic flow had no cap
// and would hang for minutes, making the feature look broken).
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder('ipv4first'); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, error: 'API key not configured' };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just: working' }]
      })
    });

    if (response.ok) {
      return { success: true, workingModel: 'gpt-4o-mini', message: 'API key verified! Using gpt-4o-mini' };
    } else {
      const errorData = await response.json();
      return { success: false, error: `API Error: ${errorData.error?.message}` };
    }
  } catch (error) {
    return { success: false, error: `Connection error: ${error.message}` };
  }
}

// Safety cap so a pathologically large catalog can't make the loader run
// forever. 1,000 pages x 10 products = up to 10,000 products.
const MAX_PRODUCT_PAGES = 1000;

// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + featuredMedia 3 + media(2 + 40×2) = 86, × 10 products ≈ 862. A caption is
// written to a product's first MAX_MEDIA_PER_PRODUCT images.
const PRODUCTS_QUERY = `#graphql
  query AltWriterProducts($cursor: String) {
    products(first: 10, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        featuredMedia { preview { image { url } } }
        media(first: ${MAX_MEDIA_PER_PRODUCT}) {
          nodes { ... on MediaImage { id alt image { url } } }
        }
      }
    }
  }
`;

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: AI alt text is Starter+. Free users go back to the app home.
  if (!(await altTextAllowed(admin, session.shop))) throw redirect('/app');

  try {
    // Alt text is generated ONCE per product (from its main image) and applied
    // to ALL of that product's images, so each row here is a PRODUCT, carrying
    // every image id so a single caption can be written to all of them.
    const { products, truncated } = await fetchAllProducts(admin, PRODUCTS_QUERY, { maxPages: MAX_PRODUCT_PAGES });
    const rows = [];

    for (const product of products) {
      const productImages = imageNodes(product)
        .map(n => ({ id: n.id, url: n.image.url, alt: n.alt || '' }));
      if (productImages.length === 0) continue; // nothing to caption

      // Use the merchandising "main" image for the thumbnail + AI input,
      // falling back to the first media image.
      const featuredUrl = product.featuredMedia?.preview?.image?.url;
      const main = productImages.find(i => i.url === featuredUrl) || productImages[0];
      const currentAlt = main.alt || '';

      rows.push({
        id: product.id,                       // row id = product id
        productId: product.id,
        productTitle: product.title,
        url: main.url,                        // main image (thumbnail + AI)
        imageIds: productImages.map(i => i.id), // apply caption to ALL of these
        imageCount: productImages.length,
        currentAlt,
        suggestedAlt: '',
        seoScore: calculateSeoScore(currentAlt),
        status: 'pending'
      });
    }

    return { images: rows, truncated };
  } catch (error) {
    console.error('Error loading products for alt text:', error);
    return { images: [], loadError: 'Could not load product images. Please refresh to try again.' };
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Tier boundary: block alt-text generation for non-entitled (Free) plans.
  if (!(await altTextAllowed(admin, session.shop))) {
    return { error: 'Alt Writer is included with Starter and above.' };
  }
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'verifyApiKey') {
    return await verifyOpenAIKey();
  }

  // Apply one product's caption to ALL of its images (chunked under Shopify's
  // 250-file limit). Returns the first userError message, or null on success.
  async function writeAltToFiles(files) {
    const FILE_UPDATE_LIMIT = 250;
    for (let i = 0; i < files.length; i += FILE_UPDATE_LIMIT) {
      const chunk = files.slice(i, i + FILE_UPDATE_LIMIT);
      const response = await admin.graphql(
        `#graphql
          mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
              files { id alt }
              userErrors { field message }
            }
          }
        `,
        { variables: { files: chunk } }
      );
      const result = await response.json();
      // Top-level GraphQL errors (throttling, auth, bad field) leave `data` null.
      // Without this check those failures fall through as a false success.
      if (result.errors?.length) {
        return result.errors[0].message || 'Shopify rejected the alt text update.';
      }
      const err = result.data?.fileUpdate?.userErrors?.[0];
      if (err) return err.message;
    }
    return null;
  }

  // Apply a single product's caption to every image of that product.
  if (actionType === 'applyAltText') {
    const imageIds = JSON.parse(formData.get('imageIds') || '[]');
    const altText = formData.get('altText');

    try {
      const files = imageIds.map(id => ({ id, alt: altText }));
      const errMsg = await writeAltToFiles(files);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true, message: 'Alt text applied to all images of the product!' };
    } catch (error) {
      console.error('Error updating image:', error);
      return { success: false, error: 'Failed to update image alt text: ' + error.message };
    }
  }

  // Bulk apply: each update is a product's caption + all of its image ids.
  // Flatten to a flat files list (one entry per image) and write chunked.
  if (actionType === 'applyBulk') {
    const updates = JSON.parse(formData.get('updates')); // [{ imageIds, altText }]

    try {
      const files = updates.flatMap(({ imageIds, altText }) =>
        (imageIds || []).map(id => ({ id, alt: altText }))
      );
      const errMsg = await writeAltToFiles(files);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true, message: `Applied captions to ${updates.length} products (${files.length} images)` };
    } catch (error) {
      console.error('Error in bulk update:', error);
      return { success: false, error: 'Failed to update some images: ' + error.message };
    }
  }

  // Caption ONE small batch per request. The client splits pending images into
  // GEN_BATCH_SIZE chunks and calls this repeatedly, so every request stays
  // short (a few seconds) and can never time out — no matter how big the store.
  if (actionType === 'generateSuggestions') {
    try {
      const imagesData = JSON.parse(formData.get('images'));
      const aiProvider = formData.get('aiProvider') || 'openai';

      const suggestions = await Promise.all(
        imagesData.map(async (image) => {
          try {
            const suggestion = await generateAIAltText(image.url, image.productTitle, aiProvider);
            return { id: image.id, suggestedAlt: suggestion.altText, seoScore: suggestion.seoScore };
          } catch (error) {
            // The AI call failed (bad/expired key, no quota, image unreachable…).
            // Log it AND tag the row so the UI can warn the merchant instead of
            // silently passing off the truncated product title as an "AI" result.
            console.error(`AI alt text failed for image ${image.id} via ${aiProvider}: ${error.message}`);
            return {
              id: image.id,
              suggestedAlt: generateSmartFallback(image.productTitle),
              seoScore: calculateSeoScore(generateSmartFallback(image.productTitle)),
              usedFallback: true,
              aiError: error.message
            };
          }
        })
      );

      // If every image fell back, the provider is down/misconfigured — surface
      // the real reason so the merchant knows to fix their API key, not retry.
      const aiError = suggestions.find(s => s.aiError)?.aiError || null;
      const fallbackCount = suggestions.filter(s => s.usedFallback).length;
      return { success: true, kind: 'suggestions', suggestions, aiError, fallbackCount };
    } catch (error) {
      return { success: false, kind: 'suggestions', error: 'Failed to generate AI suggestions: ' + error.message };
    }
  }

  return { success: false, error: 'Invalid action' };
}

function calculateSeoScore(altText) {
  if (!altText) return 0;
  let score = 50;
  const wordCount = altText.split(' ').length;
  if (wordCount >= 5 && wordCount <= 15) score += 30;
  else if (wordCount >= 3 && wordCount <= 20) score += 15;
  if (altText.match(/\b(color|size|style|material|pattern|texture|design|quality)\b/i)) score += 10;
  if (altText.length > 20 && altText.length < 125) score += 10;
  return Math.min(score, 100);
}

async function generateAIAltText(imageUrl, productTitle, provider = 'openai') {
  switch (provider) {
    case 'openai':
      return await generateWithOpenAI(imageUrl, productTitle);
    case 'anthropic':
      return await generateWithAnthropic(imageUrl, productTitle);
    default:
      return generateSmartFallbackObject(productTitle);
  }
}

async function generateWithOpenAI(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under 125 characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`
          },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    })
  }, 25000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  let altText = result.choices[0]?.message?.content?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';

  return { altText, seoScore: calculateSeoScore(altText) };
}

async function generateWithAnthropic(imageUrl, productTitle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const imageResponse = await fetchWithTimeout(imageUrl, {}, 20000);
  if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.status}`);

  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');

  let mediaType = 'image/jpeg';
  const urlLower = imageUrl.toLowerCase();
  if (urlLower.includes('.png')) mediaType = 'image/png';
  else if (urlLower.includes('.webp')) mediaType = 'image/webp';
  else if (urlLower.includes('.gif')) mediaType = 'image/gif';

  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image }
          },
          {
            type: 'text',
            text: `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under 125 characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`
          }
        ]
      }]
    })
  }, 30000);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  let altText = result.content[0]?.text?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';

  return { altText, seoScore: calculateSeoScore(altText) };
}

// Used only when the AI provider fails. Returns the product title alone — a
// factual caption — rather than inventing attributes (material, colour, quality)
// the product may not have. Rows using it are flagged `usedFallback` in the UI.
function generateSmartFallback(productTitle) {
  const altText = String(productTitle || "").trim();
  return altText.length > 125 ? altText.substring(0, 122) + "..." : altText;
}

function generateSmartFallbackObject(productTitle) {
  const altText = generateSmartFallback(productTitle);
  return { altText, seoScore: calculateSeoScore(altText) };
}

export default function AltTextSuggestions() {
  const { images: initialImages, loadError, truncated } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  // Generation runs through its own fetcher so it doesn't block (or get blocked
  // by) navigation/apply submits, and so each batch is an independent request.
  const genFetcher = useFetcher();

  const [images, setImages] = useState(initialImages);
  const [selectedImages, setSelectedImages] = useState([]);
  const [error, setError] = useState(loadError || null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [aiProvider, setAiProvider] = useState('openai');
  const [isVerifying, setIsVerifying] = useState(false);
  const [page, setPage] = useState(0);

  // Live progress for the batched generation loop: queue of remaining batches
  // plus a {done,total} counter so the user sees movement instead of a frozen
  // spinner during a long single request.
  const genQueueRef = useRef([]);
  const genProviderRef = useRef('openai');
  const [genProgress, setGenProgress] = useState(null); // { done, total } | null

  const isGenerating = genProgress !== null;
  const isSubmitting = navigation.state === 'submitting';

  // Submit the next queued batch, or finish if the queue is empty.
  const submitNextBatch = useCallback(() => {
    const batch = genQueueRef.current.shift();
    if (!batch) {
      setGenProgress(null);
      setSuccessMessage('AI suggestions generated successfully!');
      setTimeout(() => setSuccessMessage(null), 3000);
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'generateSuggestions');
    formData.append('aiProvider', genProviderRef.current);
    formData.append('images', JSON.stringify(batch.map(img => ({
      id: img.id, url: img.url, productTitle: img.productTitle
    }))));
    genFetcher.submit(formData, { method: 'post' });
  }, [genFetcher]);

  // Merge each completed batch's suggestions, advance progress, fire the next.
  useEffect(() => {
    if (genFetcher.state !== 'idle' || !genFetcher.data) return;
    const data = genFetcher.data;
    if (data.kind !== 'suggestions') return;

    if (data.success && data.suggestions) {
      setImages(prev =>
        prev.map(img => {
          const suggestion = data.suggestions.find(s => s.id === img.id);
          return suggestion
            ? { ...img, suggestedAlt: suggestion.suggestedAlt, seoScore: suggestion.seoScore, usedFallback: !!suggestion.usedFallback }
            : img;
        })
      );
      // Warn the merchant when the AI provider failed — otherwise the fallback
      // (the truncated product title) looks identical to the original and the
      // failure is invisible.
      if (data.aiError) {
        setError(`AI generation failed — showing fallback text (your product title), not a real AI description. Reason: ${data.aiError}. Check your AI provider API key/credits in the app settings.`);
      }
      setGenProgress(prev => prev ? { ...prev, done: Math.min(prev.total, prev.done + data.suggestions.length) } : prev);
    } else if (data.error) {
      setError(data.error);
    }
    submitNextBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genFetcher.state, genFetcher.data]);

  const handleVerifyApiKey = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
    setIsVerifying(true);
    const formData = new FormData();
    formData.append('actionType', 'verifyApiKey');
    submit(formData, { method: 'post' });
  }, [submit]);

  useEffect(() => {
    if (actionData?.workingModel) {
      setSuccessMessage(actionData.message);
      setIsVerifying(false);
      setTimeout(() => setSuccessMessage(null), 5000);
    } else if (actionData?.error) {
      setError(actionData.error);
      setIsVerifying(false);
    } else if (actionData?.message) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 3000);
    }
  }, [actionData]);

  const generateSuggestions = useCallback(() => {
    if (isGenerating) return;
    setError(null);
    // If the user checked specific products, only generate for those; otherwise
    // generate one caption for every pending product. One API call per product.
    const needsSuggestion = (img) => img.status === 'pending' && !img.suggestedAlt;
    const pendingImages = selectedImages.length > 0
      ? images.filter(img => selectedImages.includes(img.id) && needsSuggestion(img))
      : images.filter(needsSuggestion);
    if (pendingImages.length === 0) {
      setError(selectedImages.length > 0
        ? 'Selected products already have suggestions (or are already applied).'
        : 'All products already have suggestions. Clear existing suggestions to regenerate.');
      return;
    }
    // Split into small batches the client feeds to the server one at a time, so
    // a 200-image store never lives or dies on one multi-minute request.
    const batches = [];
    for (let i = 0; i < pendingImages.length; i += GEN_BATCH_SIZE) {
      batches.push(pendingImages.slice(i, i + GEN_BATCH_SIZE));
    }
    genQueueRef.current = batches;
    genProviderRef.current = aiProvider;
    setGenProgress({ done: 0, total: pendingImages.length });
    submitNextBatch();
  }, [images, aiProvider, isGenerating, selectedImages, submitNextBatch]);

  const handleSelectImage = useCallback((id) => {
    setSelectedImages(prev => prev.includes(id) ? prev.filter(imgId => imgId !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    const pendingImages = images.filter(img => img.status === 'pending');
    setSelectedImages(selectedImages.length === pendingImages.length ? [] : pendingImages.map(img => img.id));
  }, [selectedImages.length, images]);

  const handleApply = useCallback((productId) => {
    const product = images.find(img => img.id === productId);
    if (!product.suggestedAlt) {
      setError('Please generate a suggestion first');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyAltText');
    formData.append('imageIds', JSON.stringify(product.imageIds));
    formData.append('altText', product.suggestedAlt);
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      img.id === productId ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages(prev => prev.filter(id => id !== productId));
  }, [images, submit]);

  const handleApplySelected = useCallback(() => {
    const updates = selectedImages
      .map(id => {
        const product = images.find(img => img.id === id);
        if (!product?.suggestedAlt) return null;
        return { imageIds: product.imageIds, altText: product.suggestedAlt };
      })
      .filter(Boolean);

    if (updates.length === 0) {
      setError('Please generate suggestions for selected products first');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyBulk');
    formData.append('updates', JSON.stringify(updates));
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      selectedImages.includes(img.id) && img.suggestedAlt
        ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages([]);
  }, [selectedImages, images, submit]);

  const handleEditSuggestion = useCallback((id, newText) => {
    setImages(prev => prev.map(img =>
      img.id === id ? { ...img, suggestedAlt: newText, seoScore: calculateSeoScore(newText) } : img
    ));
  }, []);

  const getSeoScoreStatus = (score) => {
    if (score >= 80) return 'success';
    if (score >= 60) return 'warning';
    return 'critical';
  };

  const aiProviderOptions = [
    { label: 'OpenAI GPT-4o-mini (Recommended)', value: 'openai' },
    { label: 'Smart Fallback (No API)', value: 'fallback' }
  ];

  // Each row is a PRODUCT (one caption per product, applied to all its images).
  const pendingCount = images.filter(img => img.status === 'pending').length;
  const appliedCount = images.filter(img => img.status === 'applied').length;
  const productCount = images.length;
  const totalImages = images.reduce((sum, img) => sum + (img.imageCount || 0), 0);

  // Keep the current page valid as the image count changes (e.g. after a load).
  const pageCount = Math.max(1, Math.ceil(images.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);
  const pageStart = safePage * PAGE_SIZE;
  const pagedImages = images.slice(pageStart, pageStart + PAGE_SIZE);
  const rangeStart = images.length === 0 ? 0 : pageStart + 1;
  const rangeEnd = Math.min(pageStart + PAGE_SIZE, images.length);

  return (
    <Page
    >
      <Layout>
        <Layout.Section>
          <PageHeader icon={MagicIcon} eyebrow="Alt Writer" title="AI alt text" subtitle="AI reads each product's main photo and writes one caption for all of its images" />
        </Layout.Section>
        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}

        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>
              {successMessage}
            </Banner>
          </Layout.Section>
        )}

        {truncated && (
          <Layout.Section>
            <Banner tone="info">
              Showing the first {images.length} products. This store has a very large catalog,
              so caption these and reload to continue with the rest.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="800">
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Products</Text>
                    <Text variant="heading2xl" as="h2">{productCount}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Photos</Text>
                    <Text variant="heading2xl" as="h2">{totalImages}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">To review</Text>
                    <Text variant="heading2xl" as="h2">{pendingCount}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Applied</Text>
                    <Text variant="heading2xl" as="h2" tone="success">{appliedCount}</Text>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="300" blockAlign="end">
                  <Box minWidth="220px">
                    <Select
                      label=""
                      options={aiProviderOptions}
                      value={aiProvider}
                      onChange={setAiProvider}
                    />
                  </Box>
                  <Button onClick={generateSuggestions} loading={isGenerating} disabled={isGenerating}>
                    {isGenerating
                      ? `Writing ${genProgress.done}/${genProgress.total}…`
                      : 'Write suggestions'}
                  </Button>
                  {selectedImages.length > 0 && (
                    <Button
                      variant="primary"
                      onClick={handleApplySelected}
                      loading={isSubmitting && !isGenerating}
                      disabled={isSubmitting}
                    >
                      Apply to {selectedImages.length} selected
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>

              {isGenerating && (
                <BlockStack gap="200">
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Generating alt text — ${genProgress.done} of ${genProgress.total} images`}
                  </Text>
                  <ProgressBar
                    progress={genProgress.total > 0 ? Math.round((genProgress.done / genProgress.total) * 100) : 0}
                    size="small"
                    tone="primary"
                  />
                </BlockStack>
              )}

              <Divider />

              <Checkbox
                label="Select everything to review"
                checked={selectedImages.length === images.filter(img => img.status === 'pending').length && images.filter(img => img.status === 'pending').length > 0}
                onChange={handleSelectAll}
              />

              <BlockStack gap="400">
                {images.length === 0 ? (
                  <Box padding="1600">
                    <BlockStack gap="400" inlineAlign="center">
                      <Text variant="headingMd" as="h3" alignment="center">No products with photos yet</Text>
                      <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                        Add products with images to get started.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  pagedImages.map((image) => (
                    <Card key={image.id} background={selectedImages.includes(image.id) ? 'bg-surface-selected' : undefined}>
                      <InlineStack gap="400" blockAlign="start">
                        <Checkbox
                          checked={selectedImages.includes(image.id)}
                          onChange={() => handleSelectImage(image.id)}
                          disabled={image.status === 'applied'}
                        />
                        <Thumbnail source={image.url} alt={image.currentAlt || 'Product image'} size="large" />
                        <Box width="100%">
                          <BlockStack gap="400">
                            <InlineStack gap="200" blockAlign="center">
                              <Text variant="headingSm" as="h4">{image.productTitle}</Text>
                              <Badge tone="info">{`${image.imageCount} ${image.imageCount === 1 ? 'image' : 'images'}`}</Badge>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Box width="65%">
                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" fontWeight="semibold">Alt text today</Text>
                                  <Text variant="bodyMd" as="p" tone={image.currentAlt ? undefined : 'subdued'}>
                                    {image.currentAlt || 'No alt text'}
                                  </Text>
                                </BlockStack>
                              </Box>
                              <BlockStack gap="200" inlineAlign="end">
                                <Text variant="bodySm" as="p" tone="subdued">Search score</Text>
                                <Badge tone={getSeoScoreStatus(image.seoScore)}>{image.seoScore}%</Badge>
                              </BlockStack>
                            </InlineStack>

                            <Divider />

                            <BlockStack gap="300">
                              <InlineStack gap="200" blockAlign="center">
                                <Text variant="bodySm" as="p" fontWeight="semibold">Suggested by Alt Writer</Text>
                                <Text variant="bodySm" as="span" tone="subdued">(applied to all {image.imageCount} images)</Text>
                                {image.status === 'applied' && <Badge tone="success">Applied</Badge>}
                              </InlineStack>
                              <TextField
                                value={image.suggestedAlt}
                                onChange={(value) => handleEditSuggestion(image.id, value)}
                                disabled={image.status === 'applied'}
                                multiline={2}
                                autoComplete="off"
                                placeholder="Press 'Write suggestions' and Alt Writer will describe this photo…"
                              />
                            </BlockStack>

                            {image.status === 'pending' && image.suggestedAlt && (
                              <Button
                                variant="primary"
                                onClick={() => handleApply(image.id)}
                                loading={isSubmitting && !isGenerating}
                                disabled={isSubmitting}
                              >
                                Apply
                              </Button>
                            )}
                          </BlockStack>
                        </Box>
                      </InlineStack>
                    </Card>
                  ))
                )}
              </BlockStack>

              {images.length > PAGE_SIZE && (
                <InlineStack align="center" blockAlign="center" gap="400">
                  <Pagination
                    hasPrevious={safePage > 0}
                    onPrevious={() => setPage(p => Math.max(0, p - 1))}
                    hasNext={safePage < pageCount - 1}
                    onNext={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                    label={`${rangeStart}–${rangeEnd} of ${images.length} products`}
                  />
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}