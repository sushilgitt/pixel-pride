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
    tagline: "Try it out",
    features: [
      "100 images / month",
      "WebP conversion & compression",
    ],
  },
  {
    name: "Starter",
    price: 30,
    priceAnnual: 300,
    images: "2,000",
    tagline: "For growing stores",
    features: [
      "2,000 images / month",
      "Everything in Free",
      "AI alt text",
    ],
  },
  {
    name: "Growth",
    price: 99,
    priceAnnual: 990,
    images: "15,000",
    tagline: "Most popular",
    popular: true,
    features: [
      "15,000 images / month",
      "Everything in Starter",
      "Auto-optimize new products",
      "Page Speed reports",
    ],
  },
  {
    name: "Pro",
    price: 350,
    priceAnnual: 3500,
    images: "50,000",
    tagline: "High volume",
    features: [
      "50,000 images / month",
      "Everything in Growth",
      "Highest monthly image volume",
    ],
  },
];
