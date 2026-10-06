import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { getUsage } from "../usage.server";
import { entitled } from "../plans.server";
import db from "../db.server";
import { Page, Button, Badge, Icon } from "@shopify/polaris";
import {
  ImageMagicIcon,
  MagicIcon,
  AutomationIcon,
  GaugeIcon,
  PlanIcon,
  ImagesIcon,
  CheckCircleIcon,
} from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let plan = null;
  try {
    plan = (await getBillingStateCached(admin, session.shop)).plan;
  } catch (e) {
    if (e instanceof Response) throw e; // let re-auth propagate
  }

  let usage = { imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready — defaults */ }

  return {
    plan: {
      name: plan?.name || "Free",
      tier: plan?.tier || "free",
      monthlyImages: plan?.monthlyImages ?? 100,
      altText: entitled(plan, "altText"),
      pageSpeed: entitled(plan, "pageSpeed"),
      autoOptimizeAllowed: entitled(plan, "autoOptimize"),
    },
    usage,
    autoOptimize,
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { plan, usage, autoOptimize } = useLoaderData();

  const quota = plan.monthlyImages || 0;
  const used = usage?.imagesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();

  const autoStatus = !plan.autoOptimizeAllowed
    ? { label: "Growth & up", tone: "attention" }
    : autoOptimize
      ? { label: "On", tone: "success" }
      : { label: "Off", tone: undefined };

  const tools = [
    {
      icon: ImageMagicIcon,
      title: "Image Optimizer",
      desc: "Compress & convert product images to WebP. Optimized images replace the originals on the product.",
      cta: "Open optimizer",
      onClick: () => navigate("/app/productoptimization"),
      available: true,
    },
    {
      icon: MagicIcon,
      title: "AI Alt Text",
      desc: "Generate SEO alt text for every image with AI vision, then bulk-apply in one click.",
      cta: plan.altText ? "Generate alt text" : "Upgrade to Starter",
      onClick: () => navigate(plan.altText ? "/app/alttextsuggestions" : "/app/billing"),
      available: plan.altText,
      badge: plan.altText ? undefined : { label: "Starter & up", tone: "attention" },
    },
    {
      icon: AutomationIcon,
      title: "Auto-optimize",
      desc: "Set & forget — every newly created product gets optimized automatically in the background.",
      cta: plan.autoOptimizeAllowed ? "Manage" : "Upgrade to Growth",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/productoptimization" : "/app/billing"),
      available: plan.autoOptimizeAllowed,
      badge: autoStatus,
    },
    {
      icon: GaugeIcon,
      title: "Page Speed Reports",
      desc: "Track Core Web Vitals (LCP, CLS, TBT) and see before/after gains per product page.",
      cta: plan.pageSpeed ? "View reports" : "Upgrade to Growth",
      onClick: () => navigate(plan.pageSpeed ? "/app/pagespeedimpactreports" : "/app/billing"),
      available: plan.pageSpeed,
      badge: plan.pageSpeed ? undefined : { label: "Growth & up", tone: "attention" },
    },
  ];

  const stats = [
    { icon: PlanIcon, label: "Current plan", value: plan.name },
    { icon: ImagesIcon, label: "Optimized this month", value: fmt(used) },
    { icon: CheckCircleIcon, label: "Images remaining", value: fmt(remaining) },
    { icon: AutomationIcon, label: "Auto-optimize", value: autoStatus.label },
  ];

  return (
    <Page>
      {/* Hero */}
      <section className="ir-hero">
        <div>
          <p className="ir-eyebrow">Pixel Pride</p>
          <h1>
            Lighter images.<br /><em>Higher rankings.</em>
          </h1>
          <p className="ir-hero-sub">
            Compress, convert to WebP and write AI alt text for your whole catalog — so pages load
            faster and products get found.
          </p>
          <div className="ir-hero-actions">
            <button type="button" className="ir-btn ir-btn-lime" onClick={() => navigate("/app/productoptimization")}>
              Optimize images
            </button>
            <button type="button" className="ir-btn ir-btn-ghost" onClick={() => navigate("/app/billing")}>
              {`${plan.name} plan · Manage`}
            </button>
          </div>
        </div>
        <div className="ir-ring" style={{ "--pct": pct }} role="img" aria-label={`${pct}% of monthly images used`}>
          <div>
            <div className="ir-ring-value">{`${pct}%`}</div>
            <div className="ir-ring-label">{`${fmt(used)} / ${fmt(quota)} images`}</div>
          </div>
        </div>
      </section>

      {/* Stat tiles */}
      <div className="ir-stats">
        {stats.map((s) => (
          <div key={s.label} className="ir-stat">
            <span className="ir-stat-icon"><Icon source={s.icon} /></span>
            <div>
              <p className="ir-stat-value">{s.value}</p>
              <p className="ir-stat-label">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tools */}
      <p className="ir-section-title" style={{ marginTop: 28 }}>Your toolkit</p>
      <div className="ir-tools">
        {tools.map((t) => (
          <div key={t.title} className={`ir-tool${t.available ? "" : " ir-tool-locked"}`}>
            <div className="ir-tool-head">
              <span className="ir-tool-icon"><Icon source={t.icon} /></span>
              {t.badge && <Badge tone={t.badge.tone}>{t.badge.label}</Badge>}
            </div>
            <p className="ir-tool-title">{t.title}</p>
            <p className="ir-tool-desc">{t.desc}</p>
            <div>
              <Button variant={t.available ? "primary" : "secondary"} onClick={t.onClick}>
                {t.cta}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ height: 24 }} />
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
