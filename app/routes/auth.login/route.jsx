import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { login } from "../../shopify.server";

// The library redirects here when it can't identify the shop. If Shopify passed
// ?shop=, start OAuth immediately; otherwise tell the merchant to open the app
// from their Shopify admin. There is deliberately no shop-domain input — App
// Store apps must not ask merchants to type their myshopify.com URL.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return login(request); // redirects to Shopify OAuth
  }
  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Open Pixel Pride from Shopify">
          <s-paragraph>
            Pixel Pride lives inside your Shopify admin. Get it from the Shopify App Store, or
            open it from Apps in your Shopify admin to continue.
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
