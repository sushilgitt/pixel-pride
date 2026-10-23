// Managed-pricing billing helpers.
//
// This app is a Shopify "Managed Pricing" app, so it CANNOT use the Billing API
// to create charges (appSubscriptionCreate is blocked). Plans live in the
// Partner Dashboard and merchants subscribe/cancel/change on Shopify's hosted
// pricing page. The app's job is:
//   1. read the live subscription state (source of truth) to gate features, and
//   2. send merchants to the hosted pricing page to subscribe or cancel.
//
// Prices and trials are set only in the Partner Dashboard. Plan NAMES there must
// match plans.server.js (Free / Starter / Growth / Pro, plus "<name> Annual").
import { getPlanByName, FREE_PLAN } from "./plans.server";

const INSTALLATION_QUERY = `#graphql
  query AppInstallation {
    currentAppInstallation {
      app { handle }
      activeSubscriptions { id name status test currentPeriodEnd }
    }
  }`;

const CANCEL_MUTATION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

const FALLBACK_APP_HANDLE = "pixel-pride";

// Dev-only plan override. Development stores cannot approve PAID managed-pricing
// subscriptions (Shopify restriction), so paid tiers can't be tested by
// subscribing. Set DEV_PLAN_OVERRIDE=<tier> (e.g. "pro") to force a tier for
// testing, optionally scoped with DEV_PLAN_OVERRIDE_SHOP=<shop>.myshopify.com.
// Returns null (no override) unless DEV_PLAN_OVERRIDE is set, so it's inert in
// production. NEVER set these env vars on the live/production deployment.
function devPlanOverride(shop) {
  const tier = process.env.DEV_PLAN_OVERRIDE;
  if (!tier) return null;
  const only = process.env.DEV_PLAN_OVERRIDE_SHOP;
  if (only && shop && shop !== only) return null;
  const plan = getPlanByName(tier);
  return {
    appHandle: FALLBACK_APP_HANDLE,
    activeSubscription: { name: plan.name, status: "ACTIVE", test: true },
    hasActivePlan: true,
    plan,
    override: true,
  };
}

// Reads the app's handle + active subscription in a single round trip.
// Returns { appHandle, activeSubscription, hasActivePlan, plan }.
// Lets an auth Response (e.g. 401 reauthorize) propagate so the caller can
// rethrow it; any other error is treated as "no active plan".
export async function getBillingState(admin, shop = null) {
  const ov = devPlanOverride(shop);
  if (ov) return ov;
  const resp = await admin.graphql(INSTALLATION_QUERY);
  const json = await resp.json();
  const inst = json?.data?.currentAppInstallation;
  const subs = inst?.activeSubscriptions || [];
  const active = subs.find((s) => s.status === "ACTIVE") || null;
  return {
    appHandle: inst?.app?.handle || FALLBACK_APP_HANDLE,
    activeSubscription: active,
    hasActivePlan: Boolean(active),
    // Resolve the active subscription's name to a tier (quota + entitlements).
    // No active subscription → Free tier, so an installed shop is always usable.
    plan: active ? getPlanByName(active.name) : FREE_PLAN,
  };
}

// Per-shop cache of the billing state to avoid a Shopify GraphQL roundtrip on
// EVERY page navigation. Paid results are kept longer than Free ones, and
// `fresh: true` skips the cache entirely — callers pass it for full document
// loads (see isDocumentRequest), which is how a merchant comes back from
// Shopify's pricing page, so a new subscription still unlocks instantly while
// in-app navigations reuse the cached state. Concurrent lookups for the same
// shop (the /app layout and the page loader run in parallel) share one request.
const billingCache = new Map(); // shop -> { state, expires }
const inflight = new Map(); // shop -> Promise<state>
const PAID_TTL_MS = 120 * 1000;
const FREE_TTL_MS = 30 * 1000;

export async function getBillingStateCached(admin, shop, { fresh = false } = {}) {
  if (!shop) return getBillingState(admin, shop);
  if (!fresh) {
    const hit = billingCache.get(shop);
    if (hit && hit.expires > Date.now()) return hit.state;
  }
  const pending = inflight.get(shop);
  if (pending) return pending;
  const request = getBillingState(admin, shop)
    .then((state) => {
      const ttl = state.hasActivePlan ? PAID_TTL_MS : FREE_TTL_MS;
      billingCache.set(shop, { state, expires: Date.now() + ttl });
      return state;
    })
    .finally(() => inflight.delete(shop));
  inflight.set(shop, request);
  return request;
}

// Drop a shop's cached billing state (after a cancel or uninstall).
export function clearBillingCache(shop) {
  billingCache.delete(shop);
}

// True for a full page load of the embedded app (Sec-Fetch-Dest "iframe" /
// "document"); false for React Router's client-side data fetches ("empty").
// Browsers that don't send the header are treated as document loads.
export function isDocumentRequest(request) {
  const dest = request.headers.get("sec-fetch-dest");
  return !dest || dest !== "empty";
}

// Builds the Shopify-hosted managed-pricing page URL where merchants can
// subscribe, change, or cancel their plan.
export function managedPricingUrl(shop, appHandle) {
  const storeHandle = shop.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle || FALLBACK_APP_HANDLE}/pricing_plans`;
}

// App Bridge intercepts a 401 carrying this header and navigates the TOP frame
// to the URL — the only reliable way to leave the embedded iframe to an
// admin.shopify.com page (window.top.location is a cross-origin SecurityError).
export function appBridgeRedirect(url) {
  return new Response(null, {
    status: 401,
    headers: new Headers({
      "X-Shopify-API-Request-Failure-Reauthorize-Url": url,
      "Access-Control-Expose-Headers":
        "X-Shopify-API-Request-Failure-Reauthorize-Url",
    }),
  });
}

// Attempts an in-app cancel via appSubscriptionCancel. Returns the cancelled
// subscription on success; throws on userErrors (caller falls back to sending
// the merchant to the hosted pricing page to cancel there).
export async function cancelSubscription(admin, id) {
  const resp = await admin.graphql(CANCEL_MUTATION, { variables: { id } });
  const json = await resp.json();
  const errs = json?.data?.appSubscriptionCancel?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return json?.data?.appSubscriptionCancel?.appSubscription || null;
}
