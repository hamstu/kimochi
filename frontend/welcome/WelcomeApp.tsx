/**
 * ADAPTED from `src/renderer/src/windows/welcome/WelcomeApp.tsx`: every screen, route, image and
 * back target is unchanged; the layout is rebuilt on the kit (a 28px bar holding the back button,
 * an xl heading, kit buttons) and decorative glyphs (↗, 👍) became lucide icons or were dropped.
 *
 * Deltas: the four Electron IPC sends become native calls —
 *   `resize-welcome-window`            -> `resizeWelcome(height)`   (panel place, keeping x/y/width)
 *   `open-screen-capture-preferences`  -> `openScreenCapturePreferences()`
 *   `yomitan-settings-backup`          -> `openYomitanBackup()`     (Yomitan settings in the overlay)
 *   `complete-onboarding`              -> `completeOnboarding()`    (sets hasCompletedOnboarding)
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router'
import { CheckCircle2Icon, ChevronLeft, ExternalLinkIcon } from 'lucide-react'
import { Bar, Button, IconButton } from '@kit'
import { openScreenCapturePreferences } from '../bridge/tauri'
import { motion } from 'motion/react'

import AnimationLayout from './AnimationLayout'
import WindowFrame from '../components/WindowFrame'
import macOSScreenPerms from './assets/howto-screen-macos.png'

import yomitanIcon from './assets/yomitan-icon.svg'
import svgLogo from './assets/kimochi-logo.svg'
import style from './WelcomeApp.module.css'

import { useHasScreenRecordingPermission } from './useHasScreenRecordingPermission'
import { completeOnboarding, openYomitanBackup, resizeWelcome } from './welcome-actions'

/** Where each step's back button goes (unchanged from the original screens). */
const BACK: Record<string, string> = {
  '/screen-recording-permission': '/',
  '/yomitan': '/',
  '/yomitan-setup': '/yomitan',
  '/yomitan-import': '/yomitan',
  '/yomitan-import-ready': '/yomitan-import',
  '/done': '/'
}

/** One onboarding step: art, an xl heading, a paragraph and the step's actions. */
function Step({
  art,
  title,
  children,
  actions,
  wide = false
}: {
  art: ReactNode
  title: ReactNode
  children: ReactNode
  actions: ReactNode
  wide?: boolean
}): JSX.Element {
  return (
    <div className={wide ? `${style.step} ${style.wide}` : style.step}>
      <div className={style.art}>{art}</div>
      <h1 className={style.title}>{title}</h1>
      <p className={style.body}>{children}</p>
      <div className={style.actions}>{actions}</div>
    </div>
  )
}

function ExternalLink({
  href,
  onClick,
  children
}: {
  href?: string
  onClick?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <a
      className={`k-link external ${style.external}`}
      href={href}
      target={href ? '_blank' : undefined}
      rel="noreferrer"
      onClick={onClick}
    >
      {children}
      <ExternalLinkIcon aria-hidden />
    </a>
  )
}

function InitialScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  const hasPermission = useHasScreenRecordingPermission()
  return (
    <Step
      art={
        <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
          <img src={svgLogo} alt="Kimochi" width={200} />
        </motion.div>
      }
      title="Welcome to Kimochi"
      actions={
        <Button variant="primary" asChild>
          <Link to={hasPermission ? '/yomitan' : '/screen-recording-permission'}>Get Started</Link>
        </Button>
      }
    >
      Kimochi is a tool to help you read and understand Japanese on your computer (like in games or
      other visual content). It looks like this is your first run, so let&apos;s get you set up.
    </Step>
  )
}

function ScreenPermissionScreen(): JSX.Element {
  const hasPermission = useHasScreenRecordingPermission()
  useEffect(() => {
    resizeWelcome(800)
  }, [])
  return (
    <Step
      wide
      art={
        <img
          className={style.screenshot}
          src={macOSScreenPerms}
          alt="Please allow screen recording"
          width={614}
        />
      }
      title="Screen Recording Permission"
      actions={
        hasPermission ? (
          <Button variant="primary" asChild>
            <Link to="/yomitan">Continue</Link>
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              void openScreenCapturePreferences()
            }}
          >
            Open Settings <ExternalLinkIcon />
          </Button>
        )
      }
    >
      Kimochi needs screen recording permission to capture and OCR text from your screen. Please
      click the button below to open your system settings and grant access. On macOS, you may need
      to restart Kimochi after granting the permission.
    </Step>
  )
}

const yomitanArt = <img src={yomitanIcon} alt="Yomitan" width={88} />

function YomitanSetupScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Step
      art={yomitanArt}
      title="Yomitan Setup"
      actions={
        <>
          <Button variant="primary" asChild>
            <Link to="/yomitan-import">Yes, help me import my data</Link>
          </Button>
          <Button asChild>
            <Link to="/yomitan-setup">No, help me set up Yomitan</Link>
          </Button>
        </>
      }
    >
      Kimochi uses{' '}
      <ExternalLink href="https://yomitan.wiki/">a browser extension called Yomitan</ExternalLink> to
      show a popup dictionary for Japanese. Do you already have Yomitan set up in your browser of
      choice?
    </Step>
  )
}

function YomitanExportScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Step
      art={yomitanArt}
      title="Export Yomitan Data"
      actions={
        <Button variant="primary" asChild>
          <Link to="/yomitan-import-ready">Ok, I&apos;ve exported my data</Link>
        </Button>
      }
    >
      To export your Yomitan data, first open the Yomitan settings page (
      <ExternalLink href="https://yomitan.wiki/getting-started/#quick-actions">
        details here
      </ExternalLink>
      ) and click on the “Backup” category. From there you can export both settings and
      dictionaries as JSON files.
    </Step>
  )
}

function YomitanHelpScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Step
      art={yomitanArt}
      title="Yomitan How-To"
      actions={
        <Button variant="primary" asChild>
          <Link to="/yomitan-import">Ok, I&apos;ve got Yomitan set up</Link>
        </Button>
      }
    >
      We got you! First, make sure you have{' '}
      <ExternalLink href="https://yomitan.wiki/">installed the Yomitan browser extension</ExternalLink>
      . Then, once it&apos;s installed you need to install some dictionaries and customize any other
      settings to your liking. The{' '}
      <ExternalLink href="https://yomitan.wiki/getting-started/">Yomitan Wiki</ExternalLink> has a
      great guide to help you get started.
    </Step>
  )
}

function YomitanImportReadyScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(550)
  }, [])
  return (
    <Step
      art={yomitanArt}
      title="Import Yomitan Data"
      actions={
        <Button variant="primary" asChild>
          <Link to="/done">I&apos;m done importing my data</Link>
        </Button>
      }
    >
      Now that you&apos;ve exported your Yomitan data, you can import it into Kimochi. Please{' '}
      <ExternalLink
        onClick={() => {
          void openYomitanBackup()
        }}
      >
        click here to open Kimochi&apos;s Yomitan settings
      </ExternalLink>
      . From there, scroll down to the “Backup” section and import the JSON files you exported
      earlier.
    </Step>
  )
}

function DoneScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  })
  return (
    <Step
      art={
        <div className={style.kimochiDoneWrapper}>
          <CheckCircle2Icon className={style.checkboxIcon} aria-hidden />
          <img src={svgLogo} alt="Kimochi" width={200} />
        </div>
      }
      title="All Set!"
      actions={
        <Button variant="primary" asChild>
          <Link to="/main">Get Started</Link>
        </Button>
      }
    >
      You&apos;re all set up! Click the button below to close this window and start using Kimochi.
      If you need to change any settings later, you can always do so from the Kimochi preferences.
    </Step>
  )
}

function CompleteOnboarding(): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    completeOnboarding().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught))
    )
  }, [])
  if (!error) return <></>
  return (
    <Step
      art={null}
      title="Setup could not be saved"
      actions={
        <Button variant="primary" asChild>
          <Link to="/done">Back</Link>
        </Button>
      }
    >
      {error}
    </Step>
  )
}

function Welcome(): JSX.Element {
  const { pathname } = useLocation()
  const back = BACK[pathname]
  return (
    <WindowFrame windowType="app">
      <Bar position="top" className={style.bar}>
        {back && (
          <IconButton label="Back" asChild>
            <Link to={back}>
              <ChevronLeft />
            </Link>
          </IconButton>
        )}
        <span className={style.barTitle}>Kimochi setup</span>
      </Bar>
      <main className={style.content}>
        <Routes>
          <Route element={<AnimationLayout />}>
            <Route index element={<InitialScreen />} />
            <Route path="/screen-recording-permission" element={<ScreenPermissionScreen />} />
            <Route path="/yomitan" element={<YomitanSetupScreen />} />
            <Route path="/yomitan-setup" element={<YomitanHelpScreen />} />
            <Route path="/yomitan-import" element={<YomitanExportScreen />} />
            <Route path="/yomitan-import-ready" element={<YomitanImportReadyScreen />} />
            <Route path="/done" element={<DoneScreen />} />
            <Route path="/main" element={<CompleteOnboarding />} />
          </Route>
        </Routes>
      </main>
    </WindowFrame>
  )
}

export default Welcome
