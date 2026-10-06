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
        <p className={styles.eyebrow}>
          <span className={styles.mark} aria-hidden="true"><i /><i /><i /></span>
          Pixel Pride
        </p>
        <h1 className={styles.heading}>
          Every pixel, <em>perfectly tuned.</em>
        </h1>
        <p className={styles.text}>
          Compression, AI alt text and speed testing for Shopify product photos — so your store looks
          sharp and loads fast.
        </p>
        <p className={styles.note}>
          Get Pixel Pride from the Shopify App Store, then open it from Apps in your Shopify admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Compress</strong> Product photos become lean WebP files, replaced right on the product.
          </li>
          <li>
            <strong>Alt Writer</strong> AI describes each photo so shoppers and search engines know what is in it.
          </li>
          <li>
            <strong>Speed Lab</strong> On-demand Lighthouse tests show how much faster your pages got.
          </li>
        </ul>
      </div>
    </div>
  );
}
