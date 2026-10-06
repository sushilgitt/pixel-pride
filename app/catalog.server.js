// Catalog pagination shared by the loaders that list every product.
//
// Shopify rejects any single Admin GraphQL query whose *requested* cost is over
// 1,000 points, and nested connections multiply: products(first: 50) with
// images(first: 250) inside requests ~25,000 points and fails outright with
// MAX_COST_EXCEEDED. Every query passed here must therefore keep
// `products(first: N)` × (per-product cost) under 1,000 — each route's query
// documents its own budget. Images per product are capped accordingly
// (MAX_MEDIA_PER_PRODUCT); the optimizer itself (optimize.server.js) still
// processes all of a product's images, since it queries one product at a time.

export const MAX_MEDIA_PER_PRODUCT = 40;

// Safety cap so a pathologically large catalog can't make a loader run forever.
const DEFAULT_MAX_PAGES = 1000;

// Runs `query` (which must take `$cursor: String` and select
// `products(first: N, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { … } }`)
// until the last page. Returns { products, truncated }. GraphQL errors throw
// with Shopify's message instead of surfacing later as a null-data crash.
export async function fetchAllProducts(admin, query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const products = [];
  let cursor = null;
  let pages = 0;
  do {
    const response = await admin.graphql(query, { variables: { cursor } });
    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    const conn = json.data?.products;
    if (!conn) throw new Error("Products query returned no data");
    products.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < maxPages);
  return { products, truncated: Boolean(cursor) };
}

// MediaImage nodes from a `media { nodes { ... on MediaImage { … } } }`
// selection; videos / 3D models come back as empty objects and are dropped.
export function imageNodes(product) {
  return (product.media?.nodes || []).filter((n) => n?.id && n.image?.url);
}

// Parsed optimization_summary metafield (selected as `summary: metafield(…)`).
export function parseSummary(product) {
  if (!product.summary?.value) return null;
  try {
    return JSON.parse(product.summary.value);
  } catch {
    return null;
  }
}
