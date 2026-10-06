// Image-optimization pipeline (server only).
//
// Extracted from app/routes/app.Productoptimization.jsx so it can be shared by
// both the interactive optimizer route AND the background products/create
// webhook. Everything here runs server-side (uses sharp + node DNS).
//
// optimizeBatch processes ONE batch of a product's images per call and persists
// per-image + summary metafields. Callers loop it until { done: true }. It also
// enforces the per-shop monthly image quota: pass { shop, remainingQuota } and it
// caps the batch, meters usage, and reports { quotaExceeded } when the cap is hit
// with images still pending.
import sharp from "sharp";
import { setDefaultResultOrder } from "node:dns";
import { incrementUsage } from "./usage.server";

/* -------------------------------------------------------------------------- */
/*  Networking helpers                                                        */
/* -------------------------------------------------------------------------- */

// The container was hanging ~10s per image on IPv6 connect attempts to the
// Shopify CDN (ConnectTimeoutError to 2620:127:f00e::). Prefer IPv4 so fetch
// connects to the reachable address first, and cap every CDN request with an
// explicit timeout so a single bad fetch can never stall the loader or a batch.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder("ipv4first"); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

export async function timedFetch(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run async `fn` over `items` with at most `limit` in flight at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cheaply measure an image's size in MB via a HEAD request (no body download).
export async function headSizeMB(url) {
  try {
    const res = await timedFetch(url, { method: "HEAD" }, 8000);
    if (!res.ok) return 0;
    const cl = res.headers.get("content-length");
    return cl ? parseInt(cl, 10) / (1024 * 1024) : 0;
  } catch {
    return 0;
  }
}

export const BATCH_SIZE = 6;          // images optimized per batch call
export const BATCH_CONCURRENCY = 6;   // images processed in parallel within a batch

/* -------------------------------------------------------------------------- */
/*  Optimization primitives                                                   */
/* -------------------------------------------------------------------------- */

// Download + compress one image with Sharp. Always re-encodes to WebP, which
// reliably beats JPEG/PNG (typically 25-40% smaller at q80). Retries the
// download once to ride out transient CDN blips.
export async function optimizeImage(imageUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await timedFetch(imageUrl, {}, 25000);
      if (!response.ok) throw new Error(`Fetch image HTTP ${response.status}`);
      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

      const optimizedBuffer = await sharp(originalBuffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();

      const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);
      return {
        originalSizeMB,
        optimizedSizeMB,
        optimizedBuffer,
        compressionRate: originalSizeMB > 0
          ? Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
          : 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Upload the optimized buffer via a Shopify staged upload and register it as a
// new file (MediaImage). Returns the new MediaImage gid. The file is NOT yet on
// the product — finalizeReplacements attaches it once Shopify has processed it.
export async function uploadOptimizedImage(admin, optimizedBuffer, altText) {
  const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
  const mimeType = isWebP ? "image/webp" : "image/jpeg";
  const filename = `pixelpride-${Date.now()}.${isWebP ? "webp" : "jpg"}`;

  const stagedRes = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "IMAGE",
          fileSize: String(optimizedBuffer.byteLength),
        }],
      },
    }
  );
  const stagedData = await stagedRes.json();
  if (stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(stagedData.data.stagedUploadsCreate.userErrors[0].message);
  }
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Failed to create staged upload target");

  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([optimizedBuffer], { type: mimeType }), filename);
  const uploadRes = await timedFetch(target.url, { method: "POST", body: form }, 40000);
  if (!uploadRes.ok) throw new Error(`Staged upload HTTP ${uploadRes.status}`);

  const fileRes = await admin.graphql(
    `#graphql
      mutation CreateOptimizedFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        files: [{ alt: altText, contentType: "IMAGE", originalSource: target.resourceUrl, filename }],
      },
    }
  );
  const fileData = await fileRes.json();
  const fileErr = fileData.errors?.[0]?.message || fileData.data?.fileCreate?.userErrors?.[0]?.message;
  if (fileErr) throw new Error(fileErr);
  const newFile = fileData.data?.fileCreate?.files?.[0];
  if (!newFile) throw new Error("Failed to create optimized file");

  return newFile.id;
}

/* -------------------------------------------------------------------------- */
/*  Swapping originals for optimized copies without disturbing the product    */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until every new MediaImage leaves PROCESSING (or the timeout passes).
// Returns { ready: Set<id>, failed: Set<id> }. Files must be READY before
// fileUpdate can attach them to a product.
async function waitForMediaReady(admin, ids, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...ids];
  const ready = new Set();
  const failed = new Set();
  while (pending.length > 0 && Date.now() < deadline) {
    const res = await admin.graphql(
      `#graphql
        query MediaStatus($ids: [ID!]!) {
          nodes(ids: $ids) { ... on MediaImage { id status } }
        }`,
      { variables: { ids: pending } }
    );
    const json = await res.json();
    const nodes = json.data?.nodes || [];
    pending = [];
    for (const n of nodes) {
      if (!n?.id) continue;
      if (n.status === "READY") ready.add(n.id);
      else if (n.status === "FAILED") failed.add(n.id);
      else pending.push(n.id);
    }
    if (pending.length > 0) await sleep(1000);
  }
  // Still processing after the timeout: give up on those copies this round.
  for (const id of pending) failed.add(id);
  return { ready, failed };
}

// fileUpdate wrapper; returns the first error message, or null on success.
async function updateFiles(admin, files) {
  if (files.length === 0) return null;
  const res = await admin.graphql(
    `#graphql
      mutation UpdateFileRefs($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
    { variables: { files } }
  );
  const json = await res.json();
  return json.errors?.[0]?.message || json.data?.fileUpdate?.userErrors?.[0]?.message || null;
}

async function deleteFiles(admin, fileIds) {
  if (fileIds.length === 0) return;
  await admin.graphql(
    `#graphql
      mutation DeleteUnusedCopies($fileIds: [ID!]!) {
        fileDelete(fileIds: $fileIds) { deletedFileIds }
      }`,
    { variables: { fileIds } }
  );
}

// Replace each original with its optimized copy while keeping the product
// exactly as the merchant arranged it:
//   1. wait for Shopify to process the copies; discard any that fail (the
//      original stays on the product untouched),
//   2. attach the copies to the product,
//   3. point variants that used an original at its copy,
//   4. detach the originals from this product only — the original files stay
//      in Content › Files (a backup, and still intact anywhere else they're used),
//   5. move each copy into its original's position (restores order + featured image).
// `replacements` is [{ oldId, newId }]; `mediaOrder` is every media id on the
// product (images, videos, models) in its original order.
// Returns the Set of oldIds whose replacement was abandoned.
async function finalizeReplacements(admin, productId, replacements, mediaOrder) {
  const abandoned = new Set();
  if (replacements.length === 0) return abandoned;

  const { failed } = await waitForMediaReady(admin, replacements.map((r) => r.newId));
  let good = replacements.filter((r) => !failed.has(r.newId));
  for (const r of replacements) if (failed.has(r.newId)) abandoned.add(r.oldId);

  const attachErr = await updateFiles(admin, good.map((r) => ({ id: r.newId, referencesToAdd: [productId] })));
  if (attachErr) {
    // Couldn't attach the copies — leave the product exactly as it was.
    console.error(`[OPTIMIZE] attach copies to ${productId}:`, attachErr);
    for (const r of good) abandoned.add(r.oldId);
    good = [];
  }
  await deleteFiles(admin, replacements.filter((r) => abandoned.has(r.oldId)).map((r) => r.newId));
  if (good.length === 0) return abandoned;

  // Variants whose image is being replaced. Budget: 1 + variants(2 + 100 × 4) ≈ 403.
  const newIdFor = new Map(good.map((r) => [r.oldId, r.newId]));
  const varRes = await admin.graphql(
    `#graphql
      query VariantMedia($id: ID!) {
        product(id: $id) {
          variants(first: 100) { nodes { id media(first: 1) { nodes { id } } } }
        }
      }`,
    { variables: { id: productId } }
  );
  const varJson = await varRes.json();
  const variantMedia = (varJson.data?.product?.variants?.nodes || [])
    .map((v) => ({ variantId: v.id, oldId: v.media?.nodes?.[0]?.id }))
    .filter((v) => v.oldId && newIdFor.has(v.oldId))
    .map((v) => ({ variantId: v.variantId, mediaIds: [newIdFor.get(v.oldId)] }));
  if (variantMedia.length > 0) {
    const res = await admin.graphql(
      `#graphql
        mutation AttachVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
          productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
            userErrors { field message }
          }
        }`,
      { variables: { productId, variantMedia } }
    );
    const json = await res.json();
    const err = json.errors?.[0]?.message || json.data?.productVariantAppendMedia?.userErrors?.[0]?.message;
    if (err) console.error(`[OPTIMIZE] variant media for ${productId}:`, err);
  }

  const detachErr = await updateFiles(admin, good.map((r) => ({ id: r.oldId, referencesToRemove: [productId] })));
  if (detachErr) console.error(`[OPTIMIZE] detach originals from ${productId}:`, detachErr);

  // Copies were appended at the end; move each into its original's slot.
  // Applying moves in ascending target order lands every copy correctly.
  const moves = good
    .map((r) => ({ id: r.newId, newPosition: mediaOrder.indexOf(r.oldId) }))
    .filter((m) => m.newPosition >= 0)
    .sort((a, b) => a.newPosition - b.newPosition)
    .map((m) => ({ id: m.id, newPosition: String(m.newPosition) }));
  if (moves.length > 0) {
    const res = await admin.graphql(
      `#graphql
        mutation RestoreMediaOrder($id: ID!, $moves: [MoveInput!]!) {
          productReorderMedia(id: $id, moves: $moves) {
            mediaUserErrors { field message }
          }
        }`,
      { variables: { id: productId, moves } }
    );
    const json = await res.json();
    const err = json.errors?.[0]?.message || json.data?.productReorderMedia?.mediaUserErrors?.[0]?.message;
    if (err) console.error(`[OPTIMIZE] reorder media for ${productId}:`, err);
  }

  return abandoned;
}

export async function generateAIAltText(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `${productTitle} - product image`;
  try {
    // OpenAI vision fetches the image URL itself, so no base64 download needed.
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        temperature: 0.4,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Describe what you actually see. Keep under 125 characters. Don't use "image of". Return only the alt text.` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API error ${response.status}`);
    const result = await response.json();
    let altText = (result.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").replace(/\n/g, " ");
    if (altText.length > 125) altText = altText.substring(0, 122) + "...";
    return altText || `${productTitle} - product image`;
  } catch (error) {
    console.error("Error generating AI alt text:", error);
    return `${productTitle} - product image`;
  }
}

// Recompute product totals from the parsed per-image metafield records and
// persist the optimization_summary metafield.
export async function writeSummary(admin, productId, totalImages, records) {
  const processed = records.length;
  const totalOriginalSizeMB = records.reduce((s, r) => s + (r.originalSizeMB || 0), 0);
  const totalOptimizedSizeMB = records.reduce((s, r) => s + (r.optimizedSizeMB ?? r.originalSizeMB ?? 0), 0);
  const totalSizeSavedMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const compressed = records.filter(r => r.status === "optimized");
  const avgCompressionRate = compressed.length > 0
    ? Math.round(compressed.reduce((s, r) => s + (r.compressionRate || 0), 0) / compressed.length)
    : 0;

  await admin.graphql(
    `#graphql
      mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key: "optimization_summary",
          type: "json",
          value: JSON.stringify({
            totalImages,
            optimizedImages: processed,
            totalOriginalSizeMB,
            totalOptimizedSizeMB,
            totalSizeSavedMB,
            avgCompressionRate,
            lastOptimizedAt: new Date().toISOString(),
          }),
        }],
      },
    }
  );

  return { processed, totalOriginalSizeMB, totalOptimizedSizeMB, totalSizeSavedMB, avgCompressionRate };
}

/* -------------------------------------------------------------------------- */
/*  Batch — processes ONE batch per call, returns live progress               */
/* -------------------------------------------------------------------------- */

// opts:
//   shop           — when set, optimized images are metered via incrementUsage
//   remainingQuota — max images this call may optimize (default: unlimited).
//                    When 0 with images still pending, returns { quotaExceeded }.
//   genAlt         — generate AI alt text for images missing it (default true).
//                    Pass false for plans without the alt-text entitlement (Free).
export async function optimizeBatch(admin, productId, opts = {}) {
  const { shop = null, remainingQuota = Infinity, genAlt = true } = opts;

  // Query current media (MediaImage gids) + existing optimization metafields.
  const response = await admin.graphql(
    `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges { node { id ... on MediaImage { image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  // Every media id in display order — reorder positions count videos/models too.
  const mediaOrder = (product.media?.edges || []).map(e => e.node?.id).filter(Boolean);
  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Parse existing per-image records and the set of already-processed media ids.
  const records = [];
  const doneIds = new Set();
  for (const e of product.metafields.edges) {
    if (!e.node.key.startsWith("image_")) continue;
    try {
      const rec = JSON.parse(e.node.value);
      records.push(rec);
      doneIds.add(e.node.key.slice("image_".length));
    } catch { /* ignore malformed */ }
  }

  if (total === 0) {
    return { success: true, productId, total: 0, optimized: 0, remaining: 0, advanced: false, done: true,
      score: 0, sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "No photos to compress" };
  }

  const pending = images.filter(img => !doneIds.has(img.id.split("/").pop()));

  // Quota exhausted but images still need work — stop and signal the caller.
  if (pending.length > 0 && remainingQuota <= 0) {
    const processedNow = Math.min(records.length, total);
    return {
      success: true, productId, title: product.title, total,
      optimized: processedNow, remaining: total - processedNow,
      advanced: false, done: false, quotaExceeded: true,
      score: total > 0 ? Math.round((processedNow / total) * 100) : 0,
      sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "Monthly credits used up",
    };
  }

  // Cap the batch to both the per-call batch size and the remaining quota.
  const cap = Math.max(0, Math.min(BATCH_SIZE, remainingQuota));
  const batch = pending.slice(0, cap);

  // Process this batch in parallel. Each result is a per-image metafield record.
  const batchResults = (await mapLimit(batch, BATCH_CONCURRENCY, async (image) => {
    try {
      const opt = await optimizeImage(image.url);

      // Re-encoding an already-tiny image can grow it — skip so we never
      // degrade the merchant's image. Mark as processed so it isn't retried.
      if (opt.optimizedSizeMB >= opt.originalSizeMB) {
        const key = `image_${image.id.split("/").pop()}`;
        return {
          key,
          record: { status: "skipped", originalSizeMB: opt.originalSizeMB, optimizedSizeMB: opt.originalSizeMB, compressionRate: 0, optimizedAt: new Date().toISOString() },
        };
      }

      // Auto alt text is a Starter+ feature; Free plans (genAlt=false) keep the
      // image's existing alt and skip AI generation.
      let altText = image.altText;
      if (genAlt && (!altText || altText.length < 10)) {
        altText = await generateAIAltText(image.url, product.title);
      }

      const newId = await uploadOptimizedImage(admin, opt.optimizedBuffer, altText);
      const key = `image_${newId.split("/").pop()}`;
      return {
        key,
        replacement: { oldId: image.id, newId },
        record: {
          status: "optimized",
          originalSizeMB: opt.originalSizeMB,
          optimizedSizeMB: opt.optimizedSizeMB,
          compressionRate: opt.compressionRate,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
      console.error(`[OPTIMIZE] ${image.id}:`, detail);
      return null; // failure — leave pending, don't write a metafield
    }
  })).filter(Boolean);

  // Swap originals for copies in one pass, preserving order, featured image and
  // variant images. Copies Shopify failed to process are dropped (originals kept).
  let abandoned = new Set();
  try {
    abandoned = await finalizeReplacements(
      admin, productId, batchResults.filter(r => r.replacement).map(r => r.replacement), mediaOrder
    );
  } catch (err) {
    console.error(`[OPTIMIZE] finalize ${productId}:`, err?.message || err);
  }
  const newRecords = batchResults.filter(r => !(r.replacement && abandoned.has(r.replacement.oldId)));

  // Persist the per-image metafields written this batch (up to 25 per call).
  if (newRecords.length > 0) {
    await admin.graphql(
      `#graphql
        mutation CreateMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        variables: {
          metafields: newRecords.map(r => ({
            ownerId: productId,
            namespace: "image_optimization",
            key: r.key,
            type: "json",
            value: JSON.stringify(r.record),
          })),
        },
      }
    );
  }

  // Meter only images that were actually re-encoded (not skipped) against quota.
  const optimizedCount = newRecords.filter(r => r.record.status === "optimized").length;
  if (shop && optimizedCount > 0) {
    try { await incrementUsage(shop, optimizedCount); }
    catch (e) { console.error("[USAGE] increment failed:", e?.message || e); }
  }

  const allRecords = [...records, ...newRecords.map(r => r.record)];
  const totals = await writeSummary(admin, productId, total, allRecords);

  const processed = Math.min(totals.processed, total);
  const remaining = total - processed;
  const advanced = newRecords.length > 0;
  // We hit the quota cap (not the batch-size cap) yet images still remain.
  const quotaExceeded = remaining > 0 && cap < BATCH_SIZE;

  return {
    success: true,
    productId,
    title: product.title,
    total,
    optimized: processed,
    remaining,
    advanced,
    done: remaining === 0,
    quotaExceeded,
    score: total > 0 ? Math.round((processed / total) * 100) : 0,
    sizeSavedMB: totals.totalSizeSavedMB,
    originalSizeMB: totals.totalOriginalSizeMB,
    optimizedSizeMB: totals.totalOptimizedSizeMB,
    compressionRate: totals.totalOriginalSizeMB > 0
      ? Math.round((totals.totalSizeSavedMB / totals.totalOriginalSizeMB) * 100)
      : 0,
    batchFailures: batch.length - newRecords.length,
    message: remaining === 0
      ? `Compressed "${product.title}" — ${processed}/${total} photos`
      : `Compressing "${product.title}" — ${processed}/${total} photos`,
  };
}
