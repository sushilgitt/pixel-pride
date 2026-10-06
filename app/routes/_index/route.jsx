import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // No shop-domain form: App Store apps must be installed and opened from
  // Shopify (App Store / admin), never by typing a myshopify.com URL here.
  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <p className={styles.eyebrow}>◆ Pixel Pride</p>
        <h1 className={styles.heading}>Lighter images. Higher rankings.</h1>
        <p className={styles.text}>
          The image optimization & SEO suite for Shopify. Compress to WebP, write AI alt text, and track page speed.
        </p>
        <p className={styles.note}>
          Install Pixel Pride from the Shopify App Store, then open it from your Shopify admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>AI alt text</strong> Generate SEO-optimized alt text for product images using AI vision.
          </li>
          <li>
            <strong>Smart compression</strong> Shrink product images with automatic WebP conversion and compression.
          </li>
          <li>
            <strong>Page speed reports</strong> Track Core Web Vitals and PageSpeed improvements in real-time.
          </li>
        </ul>
      </div>
    </div>
  );
}
