// Client-safe pricing display catalog (marketing copy + prices) for the pricing
// page and pricing wall. The source of truth for runtime gating/quotas is
// plans.server.js — keep the prices/quotas here in sync with that file and with
// the plans created in the Partner Dashboard.
//
// Note: because this is a Managed Pricing app, every "Choose plan" button sends
// the merchant to Shopify's hosted pricing page where they pick the real plan —
// the per-tier buttons here are purely informational about what they'll get.
export const PLAN_TIERS = [
  {
    name: "Free",
    price: 0,
    priceAnnual: 0,
    images: "100",
    tagline: "Kick the tyres",
    features: [
      "100 compression credits a month",
      "WebP compression, swapped in place",
    ],
  },
  {
    name: "Starter",
    price: 30,
    priceAnnual: 300,
    images: "2,000",
    tagline: "For new shops",
    features: [
      "2,000 credits a month",
      "All Free features",
      "Alt Writer: AI alt text",
    ],
  },
  {
    name: "Growth",
    price: 99,
    priceAnnual: 990,
    images: "15,000",
    tagline: "For busy catalogs",
    popular: true,
    features: [
      "15,000 credits a month",
      "All Starter features",
      "Autopilot for new products",
      "Speed Lab Lighthouse tests",
    ],
  },
  {
    name: "Pro",
    price: 350,
    priceAnnual: 3500,
    images: "50,000",
    tagline: "For large catalogs",
    features: [
      "50,000 credits a month",
      "All Growth features",
      "Our biggest monthly allowance",
    ],
  },
];
