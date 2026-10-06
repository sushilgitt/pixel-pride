import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, sessionStorage } from "../shopify.server";
import {
  getBillingStateCached,
  managedPricingUrl,
} from "../billing.server";
import { entitled } from "../plans.server";
import PricingTiers from "../components/PricingTiers";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

function isExpiredToken(e) {
  return e?.response?.networkStatusCode === 403 || String(e?.message).includes('Forbidden');
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let hasActivePlan = false;
  let features = { pageSpeed: false, altText: false };
  // The pricing-wall CTA is a direct top-frame link to Shopify's managed-pricing
  // page, so the URL must be available even when no plan is active (that's when
  // the wall shows). Default to the fallback app handle; refined below.
  let pricingUrl = managedPricingUrl(session.shop);
  try {
    // Subscription state gates the whole app. Cached per-shop (positive results
    // only) so paying merchants don't pay a Shopify roundtrip on every click;
    // a fresh subscribe still unlocks instantly since negatives aren't cached.
    const state = await getBillingStateCached(admin, session.shop);
    hasActivePlan = state.hasActivePlan;
    // Entitlement booleans drive which nav items render (Page Speed, Alt Text).
    features = {
      pageSpeed: entitled(state.plan, "pageSpeed"),
      altText: entitled(state.plan, "altText"),
    };
    pricingUrl = managedPricingUrl(session.shop, state.appHandle);
  } catch (e) {
    // Propagate redirect Responses (e.g. OAuth flow initiated by the library),
    // but treat 4xx Responses as an expired/revoked token — trigger re-auth
    // instead of letting a raw 403 reach the browser and crash React hydration.
    if (e instanceof Response) {
      if (e.status >= 300 && e.status < 400) throw e;
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan: false, needsReauth: true, shop: session.shop };
    }
    // Expired token via a plain Error object (networkStatusCode === 403 etc.)
    if (isExpiredToken(e)) {
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", hasActivePlan: false, needsReauth: true, shop: session.shop };
    }
    hasActivePlan = false;
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    hasActivePlan,
    features,
    pricingUrl,
  };
};

export default function App() {
  const { apiKey, hasActivePlan, needsReauth, shop, features, pricingUrl } = useLoaderData();

  // Expired token: break out of the Shopify iframe so OAuth runs in the top frame
  useEffect(() => {
    if (needsReauth && shop) {
      window.top.location.href = `/auth?shop=${shop}`;
    }
  }, [needsReauth, shop]);

  if (needsReauth) return null;

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {hasActivePlan ? (
          <>
            <ui-nav-menu>
              <a href="/app" rel="home">Home</a>
              <a href="/app/productoptimization">Image Optimization</a>
              {features?.altText && (
                <a href="/app/alttextsuggestions">Alt Text Generator</a>
              )}
              {features?.pageSpeed && (
                <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
              )}
              <a href="/app/billing">Billing</a>
            </ui-nav-menu>
            <Outlet />
          </>
        ) : (
          <PricingTiers pricingUrl={pricingUrl} />
        )}
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
