import { redirect, useLoaderData, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import { getBillingState, managedPricingUrl } from "../billing.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import PricingTiers from "../components/PricingTiers";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Default to the fallback app handle so the CTA always has a target, even if
  // the billing-state lookup below fails.
  let pricingUrl = managedPricingUrl(session.shop);
  try {
    const { admin } = await authenticate.admin(request);
    const state = await getBillingState(admin);
    if (state.hasActivePlan) throw redirect("/app");
    pricingUrl = managedPricingUrl(session.shop, state.appHandle);
  } catch (e) {
    if (e instanceof Response) throw e;
    // auth or billing error — stay on pricing page with the fallback URL
  }
  return { pricingUrl };
};

export default function PricingPage() {
  const { pricingUrl } = useLoaderData();
  return <PricingTiers pricingUrl={pricingUrl} />;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
