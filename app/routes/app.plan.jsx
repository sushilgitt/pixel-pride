import PageHeader from "../components/PageHeader";
import { CreditCardIcon } from "@shopify/polaris-icons";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  cancelSubscription,
} from "../billing.server";
import { getUsage } from "../usage.server";
import { PLAN_TIERS } from "../planCatalog";
import { Page, Layout, BlockStack, Banner } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Mosaic, PixelMeter } from "../components/Pixels";

// Human labels for the entitlement flags, shown as the current plan's inclusions.
const FEATURE_LABELS = {
  optimize: "WebP compression",
  altText: "Alt Writer (AI alt text)",
  autoOptimize: "Autopilot for new products",
  pageSpeed: "Speed Lab reports",
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let state = { hasActivePlan: false, plan: null, appHandle: undefined };
  try {
    state = await getBillingState(admin, session.shop);
  } catch (e) {
    if (e instanceof Response) throw e;
  }

  let usage = { imagesUsed: 0 };
  try { usage = await getUsage(session.shop); } catch { /* table not ready */ }

  const plan = state.plan || { name: "Free", tier: "free", monthlyImages: 100, features: {} };
  const included = Object.keys(FEATURE_LABELS).filter((k) => plan.features?.[k]);

  return {
    hasActivePlan: state.hasActivePlan,
    planName: plan.name,
    tier: plan.tier,
    monthlyImages: plan.monthlyImages,
    included,
    imagesUsed: usage.imagesUsed || 0,
    // Direct top-frame link target for the Change/Choose-plan CTA.
    pricingUrl: managedPricingUrl(session.shop, state.appHandle),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  const state = await getBillingState(admin);
  const pricingUrl = managedPricingUrl(session.shop, state.appHandle);

  // Cancel: try the in-app cancel mutation first; if managed pricing blocks it,
  // fall back to the hosted page to cancel manually.
  if (actionType === "cancel") {
    const sub = state.activeSubscription;
    if (!sub) return { cancelled: true };
    try {
      await cancelSubscription(admin, sub.id);
      return { cancelled: true };
    } catch (e) {
      console.error("[BILLING] in-app cancel failed, redirecting:", e?.message);
      throw appBridgeRedirect(pricingUrl);
    }
  }

  return null;
};

export default function BillingPage() {
  const { hasActivePlan, planName, monthlyImages, included, imagesUsed, pricingUrl } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isBusy = navigation.state !== "idle";

  const post = (actionType) => {
    const fd = new FormData();
    fd.append("actionType", actionType);
    submit(fd, { method: "post" });
  };

  const quota = monthlyImages || 0;
  const used = imagesUsed || 0;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();
  const currentIdx = PLAN_TIERS.findIndex((t) => t.name === planName);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader icon={CreditCardIcon} eyebrow="Your account" title="Plan" subtitle="What you're on, how many credits you've used, and what's unlocked" />
        </Layout.Section>

        {actionData?.cancelled && !hasActivePlan && (
          <Layout.Section>
            <Banner title="Plan cancelled" tone="info">
              Your subscription has ended. Pick a plan whenever you're ready for more credits.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            <div className="pp-plan-card">
              <Mosaic />
              <div>
                <p className="pp-plan-label">{hasActivePlan ? "Active plan" : "Current plan"}</p>
                <p className="pp-plan-name">{planName}</p>
                <p className="pp-plan-sub">{`${fmt(quota)} compression credits every month`}</p>
                <div className="pp-actions">
                  <a className="pp-btn pp-btn-white" href={pricingUrl} target="_top">
                    {hasActivePlan ? "Switch plan" : "Pick a plan"}
                  </a>
                  {hasActivePlan && (
                    <button type="button" className="pp-btn pp-btn-glass" disabled={isBusy} onClick={() => post("cancel")}>
                      {isBusy ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
              </div>
              <div className="pp-plan-usage">
                <p><strong>{fmt(used)}</strong>{` of ${fmt(quota)} used`}</p>
                <PixelMeter pct={pct} label={`${pct}% of monthly credits used`} />
                <p>{`${pct}% used · resets on the 1st`}</p>
              </div>
            </div>

            <div className="pp-panel">
              <p className="pp-panel-title">Unlocked on your plan</p>
              <div className="pp-features">
                {Object.entries(FEATURE_LABELS).map(([k, label]) => {
                  const on = included.includes(k);
                  return (
                    <div key={k} className={`pp-feature${on ? "" : " is-locked"}`}>
                      <span className="pp-feature-mark" aria-hidden="true">{on ? "✓" : "·"}</span>
                      <span>{label}</span>
                      {!on && <span className="pp-feature-tag">Locked</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <div className="pp-panel">
            <p className="pp-panel-title">Compare plans</p>
            <ul className="pp-tiers">
              {PLAN_TIERS.map((t, i) => (
                <li key={t.name} className={i === currentIdx ? "is-current" : i < currentIdx ? "is-below" : ""}>
                  <span className="pp-tier-pip" aria-hidden="true" />
                  <div>
                    <p className="pp-tier-name">
                      {t.name}
                      {i === currentIdx && <span className="pp-tier-you">Current</span>}
                    </p>
                    <p className="pp-tier-meta">{`${t.images} credits / mo · $${t.price}/mo`}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="pp-side-note" style={{ marginTop: 14 }}>
              Billing is handled by Shopify and appears on your Shopify invoice. Plan changes show up
              here automatically.
            </p>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
