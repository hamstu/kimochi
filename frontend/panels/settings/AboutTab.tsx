/**
 * Settings → About: what Kimochi is and which version is running, its updates, debug info for bug
 * reports, where to find help, and the open-source work it is built on. macOS's "About Kimochi" menu item and the tray
 * menu open this page.
 */
import type { ReactNode } from "react";
import {
  AppWindow,
  AudioLines,
  BookOpen,
  BookOpenText,
  CodeXml,
  ExternalLink,
  FishingHook,
  Globe,
  Lightbulb,
  MessagesSquare,
  ScanText,
  Type,
  type LucideIcon,
} from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import {
  Badge,
  IconButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@kit";
import { useUpdateStatus } from "../../bridge/updates";
import { UpdatesSection } from "./UpdatesSection";
import { DebugInfoSection } from "./DebugInfoSection";
import {
  ACKNOWLEDGEMENTS,
  NOTICE_URL,
  creditIcon,
  type CreditGroupIcon,
} from "../../credits/credits";
import "../../credits/credits.css";
import appIcon from "../../assets/app-icon.svg";
import "./about.css";

const LINKS = [
  {
    label: "Website",
    description: "kimochiapp.com",
    url: "https://kimochiapp.com",
    icon: <Globe />,
  },
  {
    label: "Documentation",
    description: "Guides for every source, OCR engine and dictionary.",
    url: "https://docs.kimochiapp.com",
    icon: <BookOpen />,
  },
  {
    label: "Discord",
    description: "Ask questions, share setups and suggest features.",
    url: "https://discord.gg/vdMge6TBZQ",
    icon: <MessagesSquare />,
  },
  {
    label: "Source code",
    description: "Free software under the GNU GPL, version 3.",
    url: "https://github.com/hamstu/kimochi",
    icon: <CodeXml />,
  },
] as const;

const visit = (url: string): void => void openUrl(url).catch(() => undefined);

function OpenLink({ url, label }: { url: string; label: string }): ReactNode {
  return (
    <IconButton label={`Open ${label}`} size="sm" onClick={() => visit(url)}>
      <ExternalLink />
    </IconButton>
  );
}

const GROUP_ICONS: Record<CreditGroupIcon, LucideIcon> = {
  BookOpenText,
  ScanText,
  FishingHook,
  AudioLines,
  Lightbulb,
  AppWindow,
  Type,
};

/** A project's tile (shared with the website): its logo on a pale badge, or an emoji on a tint. */
function CreditTile({ id }: { id: string }): ReactNode {
  const icon = creditIcon(id);
  if ("src" in icon) {
    return (
      <span
        aria-hidden
        className={`credit-tile about-credit-tile ${icon.tint ? `credit-tint-${icon.tint}` : ""}`}
        data-logo=""
      >
        <img src={icon.src} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`credit-tile about-credit-tile credit-tint-${icon.tint}`}
    >
      {icon.emoji}
    </span>
  );
}

export function AboutTab(): ReactNode {
  const version = useUpdateStatus()?.currentVersion;
  return (
    <SettingsPage title="About" className="about-page">
      <header className="about-hero">
        <img
          className="about-icon"
          src={appIcon}
          alt=""
          width={72}
          height={72}
          draggable={false}
        />
        <div className="about-identity">
          <h2 className="about-name">Kimochi</h2>
          {version && <p className="about-version k-num">Version {version}</p>}
          <p className="about-summary">
            Read and play in Japanese: on-screen OCR, pop-up dictionaries and a
            reading log, beside any game or visual novel.
          </p>
        </div>
      </header>

      <UpdatesSection />

      <DebugInfoSection />

      <SettingsSection title="Links">
        {LINKS.map(({ label, description, url, icon }) => (
          <SettingsRow
            key={label}
            label={
              <span className="about-link-label">
                {icon}
                {label}
              </span>
            }
            description={description}
          >
            <OpenLink url={url} label={label} />
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsSection
        title="Acknowledgements"
        description="Kimochi stands on the shoulders of giants. Thank you to everyone who made and shares these."
        grouped={false}
        footnote={
          <>
            Exact versions and full licence texts are in{" "}
            <button
              type="button"
              className="about-inline-link"
              onClick={() => visit(NOTICE_URL)}
            >
              NOTICE
            </button>
            .
          </>
        }
      >
        {ACKNOWLEDGEMENTS.map((group) => {
          const GroupIcon = GROUP_ICONS[group.icon];
          return (
            <div key={group.title} className="about-credits">
              <h3 className="about-credits-title">
                <GroupIcon aria-hidden />
                {group.title}
                <span aria-hidden className="about-credits-rule" />
              </h3>
              <div className="k-settings-group">
                {group.items.map((item) => (
                  <SettingsRow
                    key={item.id}
                    label={
                      <span className="about-credit-label">
                        <CreditTile id={item.id} />
                        {item.name}
                      </span>
                    }
                    badge={
                      <Badge className="about-license">{item.license}</Badge>
                    }
                    description={item.role}
                  >
                    <OpenLink url={item.url} label={item.name} />
                  </SettingsRow>
                ))}
              </div>
            </div>
          );
        })}
      </SettingsSection>

      <p className="about-copyright">© 2026 Hamish Macpherson</p>
    </SettingsPage>
  );
}
