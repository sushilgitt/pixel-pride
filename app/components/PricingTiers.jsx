import { PLAN_TIERS } from "../planCatalog";

// 4-tier pricing comparison used by both the standalone pricing page and the
// in-app pricing wall. Presentational only: every plan CTA is a real top-frame
// link (`target="_top"`) to Shopify's hosted managed-pricing page, where the
// actual price/cycle live and are picked. A direct anchor is used (rather than a
// form POST + reauthorize-header redirect) because a user click is a reliable
// user-activation that can navigate the top frame out of the embedded iframe —
// the POST-based redirect intermittently failed during initial setup and looped
// the merchant back to the app index.
//
// Prices come from planCatalog.js and are display-only: the amount actually
// charged is set on the Partner Dashboard plans, so keep the two in sync.
export default function PricingTiers({ pricingUrl }) {
  return (
    <div style={s.page}>
      <div style={s.grid_bg} aria-hidden="true" />
      <p style={s.appLabel}>◆ Pixel Pride</p>
      <h1 style={s.heading}>
        Plans that grow <span style={s.headingAccent}>with your catalog.</span>
      </h1>
      <p style={s.subheading}>
        Faster product pages, smarter alt text, better rankings. Start free and upgrade any time.
      </p>

      <div style={s.grid}>
        {PLAN_TIERS.map((tier) => (
          <div key={tier.name} style={tier.popular ? s.cardPopular : s.card}>
            {tier.popular && <div style={s.popularBadge}>Most popular</div>}
            <p style={tier.popular ? { ...s.tierName, color: "#FFFFFF" } : s.tierName}>{tier.name}</p>
            <p style={tier.popular ? { ...s.tierTagline, color: "#9FB3C8" } : s.tierTagline}>{tier.tagline}</p>
            <div style={s.priceRow}>
              <span style={tier.popular ? { ...s.priceAmount, color: "#FFFFFF" } : s.priceAmount}>
                ${tier.price}
              </span>
              <span style={tier.popular ? { ...s.priceUnit, color: "#9FB3C8" } : s.priceUnit}>/mo</span>
            </div>
            <p style={tier.popular ? { ...s.priceAnnual, color: "#BEF264" } : s.priceAnnual}>
              {tier.price === 0
                ? "Free forever"
                : `or $${tier.priceAnnual}/year — 2 months free`}
            </p>
            <a
              href={pricingUrl}
              target="_top"
              style={{
                ...(tier.popular ? s.ctaPrimary : s.ctaSecondary),
                display: "block",
                textAlign: "center",
                textDecoration: "none",
                boxSizing: "border-box",
                cursor: "pointer",
              }}
            >
              {tier.price === 0 ? "Start free" : `Choose ${tier.name}`}
            </a>
            <div style={s.featureList}>
              {tier.features.map((f, i) => (
                <div key={i} style={s.featureRow}>
                  <span style={tier.popular ? { ...s.check, color: "#BEF264" } : s.check}>✓</span>
                  <span style={tier.popular ? { ...s.featureText, color: "#DCE6F2" } : s.featureText}>{f}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p style={s.disclaimer}>Billed securely through Shopify · Change or cancel anytime</p>
    </div>
  );
}

const display = "'Space Grotesk', 'Plus Jakarta Sans', system-ui, sans-serif";
const body = "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

const s = {
  page: {
    position: "relative",
    minHeight: "100vh",
    overflow: "hidden",
    background:
      "radial-gradient(700px 360px at 85% -5%, rgba(34,211,238,0.22), transparent 60%)," +
      "radial-gradient(700px 360px at 0% 105%, rgba(13,148,136,0.28), transparent 60%)," +
      "#0B1530",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "56px 24px",
    fontFamily: body,
  },
  grid_bg: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px)," +
      "linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)",
    backgroundSize: "32px 32px",
    pointerEvents: "none",
  },
  appLabel: {
    position: "relative",
    fontFamily: display, fontSize: 12, fontWeight: 600, letterSpacing: "0.2em",
    color: "#BEF264", margin: "0 0 16px 0", textTransform: "uppercase",
  },
  heading: {
    position: "relative",
    fontFamily: display, fontSize: 42, fontWeight: 700, color: "#FFFFFF",
    margin: "0 0 12px 0", textAlign: "center", letterSpacing: "-0.02em", lineHeight: 1.1,
  },
  headingAccent: {
    background: "linear-gradient(90deg, #5EEAD4, #BEF264)",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subheading: {
    position: "relative",
    fontSize: 15, color: "#9FB3C8", margin: "0 0 40px 0",
    textAlign: "center", maxWidth: 560, lineHeight: 1.55,
  },
  grid: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 18,
    width: "100%",
    maxWidth: 1100,
    alignItems: "stretch",
  },
  card: {
    position: "relative",
    background: "#FFFFFF",
    borderRadius: 18,
    padding: "28px 22px",
    border: "1px solid #DDE8EA",
    boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
  },
  cardPopular: {
    position: "relative",
    background: "linear-gradient(180deg, #14224A 0%, #0F1B3D 100%)",
    borderRadius: 18,
    padding: "28px 22px",
    border: "1px solid rgba(94,234,212,0.55)",
    boxShadow: "0 0 0 4px rgba(13,148,136,0.18), 0 24px 60px rgba(8,145,178,0.35)",
  },
  popularBadge: {
    position: "absolute", top: 18, right: 18,
    background: "#BEF264", color: "#0B1530",
    fontFamily: display, fontSize: 11, fontWeight: 700,
    letterSpacing: "0.06em", padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap",
    textTransform: "uppercase",
  },
  tierName: { fontFamily: display, fontSize: 20, fontWeight: 700, color: "#0B1530", margin: "0 0 2px 0" },
  tierTagline: { fontSize: 12, color: "#5B6B82", margin: "0 0 20px 0" },
  priceRow: { display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 },
  priceAmount: { fontFamily: display, fontSize: 44, fontWeight: 700, color: "#0B1530", lineHeight: 1, letterSpacing: "-0.02em" },
  priceUnit: { fontSize: 14, color: "#5B6B82", fontWeight: 500 },
  priceAnnual: { fontSize: 12, color: "#0D9488", fontWeight: 600, margin: "0 0 20px 0" },
  ctaPrimary: {
    width: "100%", padding: "12px", background: "#BEF264", color: "#0B1530",
    border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, marginBottom: 22,
    fontFamily: body, boxShadow: "0 8px 20px rgba(190,242,100,0.25)",
  },
  ctaSecondary: {
    width: "100%", padding: "12px", background: "linear-gradient(135deg, #0D9488 0%, #0891B2 100%)", color: "#FFFFFF",
    border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, marginBottom: 22,
    fontFamily: body,
  },
  featureList: { display: "flex", flexDirection: "column", gap: 10 },
  featureRow: { display: "flex", alignItems: "flex-start", gap: 8 },
  check: { color: "#0D9488", fontWeight: 800, fontSize: 13, lineHeight: "18px", flexShrink: 0 },
  featureText: { fontSize: 13, color: "#33415C", lineHeight: "18px" },
  disclaimer: { position: "relative", textAlign: "center", fontSize: 12, color: "#7D90A8", marginTop: 36 },
};
