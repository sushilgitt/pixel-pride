import { authenticate } from "./shopify.server";

// authenticate.webhook verifies the HMAC, then loads (and, with expiring
// offline tokens, refreshes) the shop's offline session. For app/uninstalled
// and the compliance topics that refresh fails — the app is no longer
// installed — and the throw would turn a valid webhook into a 500 that
// Shopify keeps retrying.
//
// Validation failures are thrown as Responses (401 bad HMAC, 400 malformed)
// and are re-thrown unchanged. Any other error can only happen AFTER the HMAC
// check passed, so the Shopify headers are trustworthy and we fall back to
// them. Only use this for handlers that don't need the admin client.
export async function authenticateWebhookWithoutSession(request) {
  const headers = request.headers;
  try {
    const { shop, topic } = await authenticate.webhook(request);
    return { shop, topic };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.warn("[WEBHOOK] session refresh failed after HMAC check:", error?.message || error);
    return {
      shop: headers.get("x-shopify-shop-domain"),
      // Header is "app/uninstalled"; the library's topic format is "APP_UNINSTALLED".
      topic: (headers.get("x-shopify-topic") || "").replace(/\//g, "_").toUpperCase(),
    };
  }
}
