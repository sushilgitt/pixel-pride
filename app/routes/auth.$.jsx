import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, login } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  // Auto-initiate OAuth when shop is known and we are exactly at /auth.
  // /auth/callback also has ?shop= but must go through authenticate.admin()
  // to complete the flow — intercepting it here breaks the callback loop.
  if (shop && url.pathname === "/auth") {
    const postRequest = new Request(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ shop }).toString(),
    });
    return login(postRequest);
  }

  await authenticate.admin(request);
  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
