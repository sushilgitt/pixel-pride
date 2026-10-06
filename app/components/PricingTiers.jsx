import { PLAN_TIERS } from "../planCatalog";
import { BrandMark, Mosaic } from "./Pixels";

// Plan comparison used by both the standalone pricing page and the in-app
// pricing wall. Presentational only: every plan CTA is a real top-frame link
// (`target="_top"`) to Shopify's hosted managed-pricing page, where the actual
// price/cycle live and are picked. A direct anchor is used (rather than a form
// POST + reauthorize-header redirect) because a user click is a reliable user
// activation that can navigate the top frame out of the embedded iframe.
//
// Prices come from planCatalog.js and are display-only: the amount actually
// charged is set on the Partner Dashboard plans, so keep the two in sync.
export default function PricingTiers({ pricingUrl }) {
  return (
    <div className="pp-pricing">
      <Mosaic />
      <header className="pp-pricing-head">
        <p className="pp-kicker"><BrandMark />PIXEL PRIDE</p>
        <h1>
          Pick the plan that fits <em>your catalog.</em>
        </h1>
        <p>
          Lighter product photos, descriptive alt text and quicker pages. Start on Free and move up
          whenever you need more credits.
        </p>
      </header>

      <div className="pp-pricing-grid">
        {PLAN_TIERS.map((tier) => (
          <div key={tier.name} className={`pp-price-card${tier.popular ? " is-popular" : ""}`}>
            {tier.popular && <span className="pp-price-flag">Best value</span>}
            <p className="pp-price-name">{tier.name}</p>
            <p className="pp-price-tag">{tier.tagline}</p>
            <p className="pp-price-amount">
              {`$${tier.price}`}<span>/month</span>
            </p>
            <p className="pp-price-annual">
              {tier.price === 0 ? "No card needed" : `$${tier.priceAnnual} billed yearly · 2 months on us`}
            </p>
            <a href={pricingUrl} target="_top" className={`pp-btn ${tier.popular ? "pp-btn-white" : "pp-btn-primary"} pp-price-cta`}>
              {tier.price === 0 ? "Start on Free" : `Get ${tier.name}`}
            </a>
            <ul className="pp-price-features">
              {tier.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="pp-pricing-foot">Charged through your Shopify bill · switch or cancel any time</p>
    </div>
  );
}
