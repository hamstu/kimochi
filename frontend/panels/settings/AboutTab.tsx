/**
 * Settings → About: what Kimochi is and which version is running, its updates, where to find
 * help, and the open-source work it is built on. macOS's "About Kimochi" menu item and the tray
 * menu open this page.
 */
import type { ReactNode } from 'react'
import { BookOpen, CodeXml, ExternalLink, Globe, MessagesSquare } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Badge, IconButton, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { useUpdateStatus } from '../../bridge/updates'
import { UpdatesSection } from './UpdatesSection'
import { ACKNOWLEDGEMENTS } from './acknowledgements'
import appIcon from '../../assets/app-icon.svg'
import './about.css'

const LINKS = [
  {
    label: 'Website',
    description: 'kimochiapp.com',
    url: 'https://kimochiapp.com',
    icon: <Globe />
  },
  {
    label: 'Documentation',
    description: 'Guides for every source, OCR engine and dictionary.',
    url: 'https://docs.kimochiapp.com',
    icon: <BookOpen />
  },
  {
    label: 'Discord',
    description: 'Ask questions, share setups and suggest features.',
    url: 'https://discord.gg/vdMge6TBZQ',
    icon: <MessagesSquare />
  },
  {
    label: 'Source code',
    description: 'Free software under the GNU GPL, version 3.',
    url: 'https://github.com/hamstu/kimochi-tauri',
    icon: <CodeXml />
  }
] as const

const NOTICE_URL = 'https://github.com/hamstu/kimochi-tauri/blob/main/NOTICE'

const visit = (url: string): void => void openUrl(url).catch(() => undefined)

function OpenLink({ url, label }: { url: string; label: string }): ReactNode {
  return (
    <IconButton label={`Open ${label}`} size="sm" onClick={() => visit(url)}>
      <ExternalLink />
    </IconButton>
  )
}

export function AboutTab(): ReactNode {
  const version = useUpdateStatus()?.currentVersion
  return (
    <SettingsPage title="About" className="about-page">
      <header className="about-hero">
        <img className="about-icon" src={appIcon} alt="" width={72} height={72} draggable={false} />
        <div className="about-identity">
          <h2 className="about-name">Kimochi</h2>
          {version && <p className="about-version k-num">Version {version}</p>}
          <p className="about-summary">
            Read and play in Japanese: on-screen OCR, pop-up dictionaries and a reading log,
            beside any game or visual novel.
          </p>
        </div>
      </header>

      <UpdatesSection />

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
            Exact versions and full licence texts are in{' '}
            <button type="button" className="about-inline-link" onClick={() => visit(NOTICE_URL)}>
              NOTICE
            </button>
            .
          </>
        }
      >
        {ACKNOWLEDGEMENTS.map((group) => (
          <div key={group.title} className="about-credits">
            <h3 className="about-credits-title">{group.title}</h3>
            <div className="k-settings-group">
              {group.items.map((item) => (
                <SettingsRow
                  key={item.name}
                  label={item.name}
                  badge={<Badge className="about-license">{item.license}</Badge>}
                  description={item.role}
                >
                  <OpenLink url={item.url} label={item.name} />
                </SettingsRow>
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>

      <p className="about-copyright">© 2026 Hamish Macpherson</p>
    </SettingsPage>
  )
}
