import { authenticateWebhookWithoutSession } from "../webhooks.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticateWebhookWithoutSession(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Idempotent: safe if the webhook is retried or sessions are already gone.
  // Usage and settings are kept until shop/redact (see webhooks.compliance).
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
