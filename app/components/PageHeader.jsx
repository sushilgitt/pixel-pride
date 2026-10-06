import { Icon } from "@shopify/polaris";
import { Mosaic } from "./Pixels";

// Branded header card shown at the top of each feature page.
export default function PageHeader({ icon, eyebrow, title, subtitle }) {
  return (
    <div className="pp-page-header">
      <span className="pp-page-header-icon">
        <Icon source={icon} />
      </span>
      <div className="pp-page-header-text">
        {eyebrow && <p className="pp-page-header-eyebrow">{eyebrow}</p>}
        <p className="pp-page-header-title">{title}</p>
        {subtitle && <p className="pp-page-header-sub">{subtitle}</p>}
      </div>
      <Mosaic cells={15} />
    </div>
  );
}
