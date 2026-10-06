// products/create webhook — background "set & forget" auto-optimization.
//
// When a merchant on a plan that includes autoOptimize (Growth+) has the toggle
// enabled, every newly created product gets its images optimized automatically.
//
// Shopify expects a fast ACK (a slow webhook is retried / disabled), and image
// optimization is heavy, so we acknowledge immediately and run the work
// out-of-band. Work is serialized per shop (a simple in-process promise chain)
// so a bulk import doesn't stampede the optimizer or drop products. This is
// sufficient for the single long-running Node instance on Coolify; a durable job
// queue (e.g. Redis/BullMQ) would be the hardening follow-up for multi-instance.
//
// We deliberately subscribe to products/create only (not products/update), so the
// media replacement performed during optimization can't re-trigger this webhook.
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { getBillingState } from "../billing.server";
import { entitled } from "../plans.server";
import { getRemaining } from "../usage.server";
import { optimizeBatch } from "../optimize.server";

// Per-shop sequential task queue. Tasks chain off the previous one so products
// created in quick succession are processed in order rather than concurrently.
const queues = new Map(); // shop -> Promise (tail of the chain)

function enqueue(shop, task) {
  const prev = queues.get(shop) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((e) => console.error("[AUTO-OPT]", shop, e?.message || e));
  queues.set(shop, next);
  // Drop the map entry once the chain drains (only if no newer task replaced it).
  next.finally(() => {
    if (queues.get(shop) === next) queues.delete(shop);
  });
}

async function runAutoOptimize(shop, productGid) {
  // Cheapest gate first: skip entirely unless the merchant turned this on.
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings?.autoOptimize) return;

  // Offline admin client (uses the stored offline access token for the shop).
  const { admin } = await unauthenticated.admin(shop);

  const { plan } = await getBillingState(admin);
  if (!entitled(plan, "autoOptimize")) return; // plan changed since toggle was set
  const genAlt = entitled(plan, "altText"); // Growth/Pro always include alt text

  // Loop batches until the product is fully optimized or the monthly quota runs
  // out. The 50-iteration ceiling is a safety backstop (250 images / batch of 6).
  for (let i = 0; i < 50; i++) {
    const remainingQuota = await getRemaining(shop, plan);
    if (remainingQuota <= 0) break;
    const res = await optimizeBatch(admin, productGid, { shop, remainingQuota, genAlt });
    if (!res.success || res.done || res.quotaExceeded || !res.advanced) break;
  }
}

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productGid =
    payload?.admin_graphql_api_id ||
    (payload?.id ? `gid://shopify/Product/${payload.id}` : null);

  if (productGid) {
    enqueue(shop, () => runAutoOptimize(shop, productGid));
  }

  // ACK immediately — the optimization runs in the background.
  return new Response();
};
