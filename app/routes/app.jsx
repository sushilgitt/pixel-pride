import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, sessionStorage } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { entitled } from "../plans.server";

import "@shopify/polaris/build/esm/styles.css";

import enTranslations from "@shopify/polaris/locales/en.json";

function isExpiredToken(e) {
  return e?.response?.networkStatusCode === 403 || String(e?.message).includes('Forbidden');
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Free-tier defaults; refined from the live subscription below.
  let features = { pageSpeed: false, altText: false };
  try {
    // Subscription state decides which features unlock. Cached per-shop
    // (positive results only) so paying merchants don't pay a Shopify roundtrip
    // on every click; a fresh subscribe still unlocks instantly.
    const state = await getBillingStateCached(admin, session.shop);
    // Entitlement booleans drive which nav items render (Page Speed, Alt Text).
    features = {
      pageSpeed: entitled(state.plan, "pageSpeed"),
      altText: entitled(state.plan, "altText"),
    };
  } catch (e) {
    // Propagate redirect Responses (e.g. OAuth flow initiated by the library),
    // but treat 4xx Responses as an expired/revoked token — trigger re-auth
    // instead of letting a raw 403 reach the browser and crash React hydration.
    if (e instanceof Response) {
      if (e.status >= 300 && e.status < 400) throw e;
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", needsReauth: true, shop: session.shop };
    }
    // Expired token via a plain Error object (networkStatusCode === 403 etc.)
    if (isExpiredToken(e)) {
      await sessionStorage.deleteSession(session.id);
      // eslint-disable-next-line no-undef
      return { apiKey: process.env.SHOPIFY_API_KEY || "", needsReauth: true, shop: session.shop };
    }
    // Any other billing error: fall back to the Free tier defaults.
  }

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    features,
  };
};

export default function App() {
  const { apiKey, needsReauth, shop, features } = useLoaderData();

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
        {/* No hard paywall: a shop without a paid subscription runs on the Free
            tier (see getBillingState), and upgrades happen from the Plan page. */}
        <ui-nav-menu>
          <a href="/app" rel="home">Overview</a>
          <a href="/app/optimize">Compress</a>
          {features?.altText && (
            <a href="/app/alt-text">Alt Writer</a>
          )}
          {features?.pageSpeed && (
            <a href="/app/speed">Speed Lab</a>
          )}
          <a href="/app/plan">Plan</a>
        </ui-nav-menu>
        <Outlet />
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
