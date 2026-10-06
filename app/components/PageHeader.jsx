import { Icon } from "@shopify/polaris";

// Dark branded header strip shown at the top of each feature page.
export default function PageHeader({ icon, eyebrow, title, subtitle }) {
  return (
    <div className="ir-page-header">
      <span className="ir-page-header-icon">
        <Icon source={icon} />
      </span>
      <div>
        {eyebrow && <p className="ir-page-header-eyebrow">{eyebrow}</p>}
        <p className="ir-page-header-title">{title}</p>
        {subtitle && <p className="ir-page-header-sub">{subtitle}</p>}
      </div>
    </div>
  );
}
