// Per-shop monthly image-usage metering.
//
// Plan quotas (see plans.server.js) are enforced against a counter that resets
// each calendar month. Usage is keyed by shop + period ("YYYY-MM"), so a fresh
// row is created at the start of every month and the previous month's count is
// preserved for reference.
import db from "./db.server";
import { FREE_PLAN } from "./plans.server";

// Current month as "YYYY-MM" (UTC). A new period string each month means a new
// counter row, which is how usage "resets".
export function currentPeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Read this shop's usage for the current period. Returns { period, imagesUsed }
// without creating a row (a missing row means zero used).
export async function getUsage(shop) {
  const period = currentPeriod();
  const row = await db.usageCounter.findUnique({
    where: { shop_period: { shop, period } },
  });
  return { period, imagesUsed: row?.imagesUsed ?? 0 };
}

// Atomically add `n` to this shop's current-period counter, creating the row on
// first use. No-op for n <= 0. Returns the new total.
export async function incrementUsage(shop, n) {
  if (!n || n <= 0) return (await getUsage(shop)).imagesUsed;
  const period = currentPeriod();
  const row = await db.usageCounter.upsert({
    where: { shop_period: { shop, period } },
    create: { shop, period, imagesUsed: n },
    update: { imagesUsed: { increment: n } },
  });
  return row.imagesUsed;
}

// Images this shop may still optimize this month under `plan` (>= 0).
export async function getRemaining(shop, plan) {
  const quota = (plan || FREE_PLAN).monthlyImages;
  const { imagesUsed } = await getUsage(shop);
  return Math.max(0, quota - imagesUsed);
}
