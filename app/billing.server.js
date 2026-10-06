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
// EVERY page navigation. We deliberately cache only the POSITIVE result
// (hasActivePlan === true): paying merchants — who navigate the app the most —
// get instant page loads, while non-subscribers are always re-checked so the
// moment they subscribe on Shopify's page and return, the app unlocks
// instantly. A cancel relocks within BILLING_TTL_MS, which is fine.
const billingCache = new Map(); // shop -> { state, expires }
const BILLING_TTL_MS = 120 * 1000;

export async function getBillingStateCached(admin, shop) {
  if (shop) {
    const hit = billingCache.get(shop);
    if (hit && hit.expires > Date.now()) return hit.state;
  }
  const state = await getBillingState(admin, shop);
  if (shop) {
    if (state.hasActivePlan) {
      billingCache.set(shop, { state, expires: Date.now() + BILLING_TTL_MS });
    } else {
      billingCache.delete(shop);
    }
  }
  return state;
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
