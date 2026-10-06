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
import { BrandMark, Mosaic, PixelMeter } from "../components/Pixels";

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
    ? { label: "Growth plan", tone: "attention" }
    : autoOptimize
      ? { label: "Running", tone: "success" }
      : { label: "Paused", tone: undefined };

  const tools = [
    {
      icon: ImageMagicIcon,
      title: "Compress",
      desc: "Re-encode product photos as lean WebP files and swap them in place — same look, a fraction of the weight.",
      cta: "Start compressing",
      onClick: () => navigate("/app/optimize"),
      available: true,
    },
    {
      icon: MagicIcon,
      title: "Alt Writer",
      desc: "AI looks at each product photo and writes descriptive, search-friendly alt text you can apply in bulk.",
      cta: plan.altText ? "Write alt text" : "Unlock with Starter",
      onClick: () => navigate(plan.altText ? "/app/alt-text" : "/app/plan"),
      available: plan.altText,
      badge: plan.altText ? undefined : { label: "Starter+", tone: "attention" },
    },
    {
      icon: AutomationIcon,
      title: "Autopilot",
      desc: "New products get compressed automatically the moment they are created — nothing to remember.",
      cta: plan.autoOptimizeAllowed ? "Configure" : "Unlock with Growth",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/optimize" : "/app/plan"),
      available: plan.autoOptimizeAllowed,
      badge: autoStatus,
    },
    {
      icon: GaugeIcon,
      title: "Speed Lab",
      desc: "Run live Lighthouse tests on product pages and see exactly how much image weight you have shed.",
      cta: plan.pageSpeed ? "Open Speed Lab" : "Unlock with Growth",
      onClick: () => navigate(plan.pageSpeed ? "/app/speed" : "/app/plan"),
      available: plan.pageSpeed,
      badge: plan.pageSpeed ? undefined : { label: "Growth+", tone: "attention" },
    },
  ];

  const stats = [
    { icon: PlanIcon, label: "Plan", value: plan.name },
    { icon: ImagesIcon, label: "Compressed this month", value: fmt(used) },
    { icon: CheckCircleIcon, label: "Credits left", value: fmt(remaining) },
    { icon: AutomationIcon, label: "Autopilot", value: autoStatus.label },
  ];

  return (
    <Page>
      <section className="pp-hero">
        <div className="pp-hero-main">
          <p className="pp-kicker"><BrandMark />PIXEL PRIDE</p>
          <h1>
            Every pixel, <em>perfectly tuned.</em>
          </h1>
          <p className="pp-hero-sub">
            Shrink product photos to WebP, give every image meaningful alt text, and watch your
            storefront get quicker — all from one calm dashboard.
          </p>
          <div className="pp-actions">
            <button type="button" className="pp-btn pp-btn-primary" onClick={() => navigate("/app/optimize")}>
              Compress images
            </button>
            <button type="button" className="pp-btn pp-btn-outline" onClick={() => navigate("/app/plan")}>
              View plan
            </button>
          </div>
          <Mosaic />
        </div>

        <div className="pp-usage-card">
          <Mosaic />
          <div>
            <p className="pp-usage-label">{`${plan.name} · this month`}</p>
            <p className="pp-usage-big">
              {fmt(used)}<span>{` / ${fmt(quota)}`}</span>
            </p>
            <p className="pp-usage-foot">images compressed</p>
          </div>
          <PixelMeter pct={pct} label={`${pct}% of monthly images used`} />
          <p className="pp-usage-foot">{`${fmt(remaining)} credits left · resets on the 1st`}</p>
        </div>
      </section>

      <div className="pp-stats">
        {stats.map((s) => (
          <div key={s.label} className="pp-stat">
            <div className="pp-stat-top">
              <span className="pp-stat-icon"><Icon source={s.icon} /></span>
              {s.label}
            </div>
            <p className="pp-stat-value">{s.value}</p>
          </div>
        ))}
      </div>

      <p className="pp-section-title"><BrandMark />Tools</p>
      <div className="pp-tools">
        {tools.map((t) => (
          <div key={t.title} className={`pp-tool${t.available ? "" : " pp-tool-locked"}`}>
            <span className="pp-tool-icon"><Icon source={t.icon} /></span>
            <div className="pp-tool-body">
              <div className="pp-tool-head">
                <p className="pp-tool-title">{t.title}</p>
                {t.badge && <Badge tone={t.badge.tone}>{t.badge.label}</Badge>}
              </div>
              <p className="pp-tool-desc">{t.desc}</p>
              <div>
                <Button variant={t.available ? "primary" : "secondary"} onClick={t.onClick}>
                  {t.cta}
                </Button>
              </div>
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
