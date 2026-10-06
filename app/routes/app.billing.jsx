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

// Human labels for the entitlement flags, shown as the current plan's inclusions.
const FEATURE_LABELS = {
  optimize: "Image optimization & WebP conversion",
  altText: "AI alt text",
  autoOptimize: "Auto-optimize new products",
  pageSpeed: "Page Speed reports",
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
          <PageHeader icon={CreditCardIcon} eyebrow="Account" title="Plan & billing" subtitle="Your plan, monthly usage and what's included" />
        </Layout.Section>

        {actionData?.cancelled && !hasActivePlan && (
          <Layout.Section>
            <Banner title="Subscription cancelled" tone="info">
              Your plan has been cancelled. Choose a plan any time to unlock more.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            {/* Membership card */}
            <div className="ir-plan-card">
              <div>
                <p className="ir-eyebrow">{hasActivePlan ? "Active plan" : "Current plan"}</p>
                <p className="ir-plan-name">{planName}</p>
                <p className="ir-plan-sub">{`Up to ${fmt(quota)} optimized images every month`}</p>
                <div className="ir-hero-actions">
                  <a className="ir-btn ir-btn-lime" href={pricingUrl} target="_top">
                    {hasActivePlan ? "Change plan" : "Choose a plan"}
                  </a>
                  {hasActivePlan && (
                    <button type="button" className="ir-btn ir-btn-ghost" disabled={isBusy} onClick={() => post("cancel")}>
                      {isBusy ? "Cancelling…" : "Cancel plan"}
                    </button>
                  )}
                </div>
              </div>
              <div className="ir-ring" style={{ "--pct": pct }} role="img" aria-label={`${pct}% of monthly images used`}>
                <div>
                  <div className="ir-ring-value">{`${pct}%`}</div>
                  <div className="ir-ring-label">{`${fmt(used)} / ${fmt(quota)} used`}</div>
                </div>
              </div>
            </div>

            {/* Feature checklist */}
            <div className="ir-panel">
              <p className="ir-panel-title">What&apos;s included</p>
              <div className="ir-features">
                {Object.entries(FEATURE_LABELS).map(([k, label]) => {
                  const on = included.includes(k);
                  return (
                    <div key={k} className={`ir-feature${on ? "" : " is-locked"}`}>
                      <span className="ir-feature-mark" aria-hidden="true">{on ? "✓" : "–"}</span>
                      <span>{label}</span>
                      {!on && <span className="ir-feature-tag">Upgrade</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </BlockStack>
        </Layout.Section>

        {/* Plan ladder */}
        <Layout.Section variant="oneThird">
          <div className="ir-panel">
            <p className="ir-panel-title">All plans</p>
            <ol className="ir-ladder">
              {PLAN_TIERS.map((t, i) => (
                <li key={t.name} className={i === currentIdx ? "is-current" : i < currentIdx ? "is-below" : ""}>
                  <span className="ir-ladder-dot" aria-hidden="true" />
                  <div>
                    <p className="ir-ladder-name">
                      {t.name}
                      {i === currentIdx && <span className="ir-ladder-you">You</span>}
                    </p>
                    <p className="ir-ladder-meta">{`${t.images} images / mo · $${t.price}/mo`}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="ir-side-note" style={{ marginTop: 14 }}>
              Plans are billed securely by Shopify. Upgrades, downgrades and monthly/yearly switches
              show up here automatically.
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
