/**
 * COPY of `src/renderer/src/windows/welcome/WelcomeApp.tsx` — every screen, route, image and word
 * of copy is unchanged.
 *
 * Deltas: the four Electron IPC sends become native calls —
 *   `resize-welcome-window`            -> `resizeWelcome(height)`   (panel place, keeping x/y/width)
 *   `open-screen-capture-preferences`  -> `openScreenCapturePreferences()`
 *   `yomitan-settings-backup`          -> `openYomitanBackup()`     (Yomitan settings in the overlay)
 *   `complete-onboarding`              -> `completeOnboarding()`    (sets hasCompletedOnboarding)
 */
import {
  Button,
  Container,
  Flex,
  Heading,
  IconButton,
  Text,
  Link as RadixLink
} from '@radix-ui/themes'
import { useEffect, useState, type JSX } from 'react'
import { Link, Route, Routes } from 'react-router'
import { CheckCircle2Icon, ChevronLeft, ExternalLinkIcon } from 'lucide-react'
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

function BackButton({ to }: { to: string }): JSX.Element {
  return (
    <IconButton
      asChild
      variant="ghost"
      color="gray"
      style={{ position: 'absolute', top: 30, left: 30 }}
    >
      <Link to={to}>
        <ChevronLeft />
      </Link>
    </IconButton>
  )
}

function InitialScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  const hasPermission = useHasScreenRecordingPermission()
  return (
    <Flex direction="column" align="center" gap="6">
      <div className={style.iconWrapper}>
        <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
          <img src={svgLogo} alt="Kimochi" width={220} />
        </motion.div>
      </div>
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Welcome to Kimochi
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          Kimochi is a tool to help you read and understand Japanese on your computer (like in games
          or other visual content). It looks like this your first run, so let&apos;s get you set up.
        </Text>
      </section>
      <Button variant="classic" size="2" asChild>
        <Link to={hasPermission ? '/yomitan' : '/screen-recording-permission'}>Get Started</Link>
      </Button>
    </Flex>
  )
}

function ScreenPermissionScreen(): JSX.Element {
  const hasPermission = useHasScreenRecordingPermission()
  useEffect(() => {
    resizeWelcome(800)
  }, [])
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/" />
      <img src={macOSScreenPerms} alt="Please allow screen recording" width={614} />
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Screen Recording Permission
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          Kimochi needs screen recording permission to capture and OCR text from your screen. Please
          click the button below to open your system settings and grant access. On macOS, you may
          need to restart Kimochi after granting the permission.
        </Text>
      </section>
      {!hasPermission && (
        <Button
          variant="outline"
          size="2"
          onClick={() => {
            void openScreenCapturePreferences()
          }}
        >
          Open Settings <ExternalLinkIcon size="16" />
        </Button>
      )}
      {hasPermission && (
        <Button variant="outline" size="2" asChild>
          <Link to="/yomitan">Continue</Link>
        </Button>
      )}
    </Flex>
  )
}

function YomitanSetupScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/" />
      <img src={yomitanIcon} alt="Yomitan" width={105} />
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Yomitan Setup
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          Kimochi uses{' '}
          <RadixLink
            href="https://yomitan.wiki/"
            target="_blank"
            rel="noreferrer"
            className="external"
          >
            a browser extension called Yomitan
          </RadixLink>{' '}
          to show a popup dictionary for Japanese. Do you already have Yomitan set up in your
          browser of choice?
        </Text>
      </section>
      <Flex direction="row" gap="4" align="center">
        <Button variant="classic" size="2" asChild>
          <Link to="/yomitan-import">Yes, help me import my data</Link>
        </Button>
        <Button variant="outline" size="2" asChild>
          <Link to="/yomitan-setup">No, help me set up Yomitan</Link>
        </Button>
      </Flex>
    </Flex>
  )
}

// function YomitanSettingsDialog({ children }: { children: JSX.Element }): JSX.Element {
//   // add to clipboard on load
//   return (
//     <Dialog.Root>
//       <Dialog.Trigger>{children}</Dialog.Trigger>

//       <Dialog.Content maxWidth="450px">
//         <Dialog.Description>
//           <Text as="p" size="2">
//             We&apos;ve just copied the URL to your clipboard. Please open your browser and paste it
//             in the address bar to open the Yomitan settings page.
//           </Text>
//           <Text as="p" size="2" color="gray" mt="2">
//             Here is the link if you want to copy it yourself:
//           </Text>
//           <pre>chrome-extension://likgccmbimhjbgkjambclfkhldnlhbnn/settings.html</pre>
//         </Dialog.Description>

//         <Flex gap="3" mt="4" justify="end">
//           <Dialog.Close>
//             <Button variant="soft" color="gray">
//               Got it
//             </Button>
//           </Dialog.Close>
//         </Flex>
//       </Dialog.Content>
//     </Dialog.Root>
//   )
// }

function YomitanExportScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/yomitan" />
      <img src={yomitanIcon} alt="Yomitan" width={105} />
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Export Yomitan Data
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          To export your Yomitan data, first open the Yomitan settings page —
          <RadixLink
            className="external"
            href="https://yomitan.wiki/getting-started/#quick-actions"
            target="_blank"
            rel="noreferrer"
          >
            details here ↗
          </RadixLink>{' '}
          — and click on the “Backup” category. From there you can export both settings and
          dictionaries as JSON files.
        </Text>
      </section>
      <Flex direction="row" gap="4" align="center">
        <Button variant="classic" size="2" asChild>
          <Link to="/yomitan-import-ready">Ok, I&apos;ve exported my data</Link>
        </Button>
      </Flex>
    </Flex>
  )
}

function YomitanHelpScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  }, [])
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/yomitan" />
      <img src={yomitanIcon} alt="Yomitan" width={105} />
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Yomitan How-To
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          We got you! First, make sure you have{' '}
          <RadixLink
            className="external"
            href="https://yomitan.wiki/"
            target="_blank"
            rel="noreferrer"
          >
            installed the Yomitan browser extension
          </RadixLink>
          . Then, once it&apos;s installed you need to install some dictionaries and customize any
          other settings to your liking. The{' '}
          <RadixLink
            href="https://yomitan.wiki/getting-started/"
            target="_blank"
            rel="noreferrer"
            className="external"
          >
            Yomitan Wiki
          </RadixLink>{' '}
          has a great guide to help you get started.
        </Text>
      </section>
      <Flex direction="row" gap="4" align="center">
        <Button variant="classic" size="2" asChild>
          <Link to="/yomitan-import">Ok, I&apos;ve got Yomitan set up</Link>
        </Button>
        {/* <Button variant="outline" size="2" asChild>
          <Link to="/yomitan-setup">No, help me set up Yomitan</Link>
        </Button> */}
      </Flex>
    </Flex>
  )
}

function YomitanImportReadyScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(550)
  }, [])
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/yomitan-import" />
      <img src={yomitanIcon} alt="Yomitan" width={105} />
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Import Yomitan Data
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
          Now that you&apos;ve exported your Yomitan data, you can import it into Kimochi. Please{' '}
          <RadixLink
            rel="noreferrer"
            className="external"
            onClick={() => {
              void openYomitanBackup()
            }}
          >
            click here to open Kimochi&apos;s Yomitan settings ↗{' '}
          </RadixLink>
          . From there, scroll down to the “Backup” section and import the JSON files you exported
          earlier.
        </Text>
      </section>

      <Button variant="classic" size="2" asChild>
        <Link to="/done">I&apos;m done importing my data 👍</Link>
      </Button>
    </Flex>
  )
}

function DoneScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500)
  })
  return (
    <Flex direction="column" align="center" gap="6">
      <BackButton to="/" />
      <div className={style.kimochiDoneWrapper}>
        <CheckCircle2Icon size="64" color="green" className={style.checkboxIcon} />
        <img src={svgLogo} alt="Kimochi" width={220} />
      </div>
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        All Set!
      </Heading>
      <section>
        <Text size="2" style={{ textAlign: 'left', width: '100%' }}>
          You&apos;re all set up! Click the button below to close this window and start using
          Kimochi. If you need to change any settings later, you can always do so from the Kimochi
          preferences.
        </Text>
      </section>
      <Button variant="classic" size="2" asChild>
        <Link to="/main">Get Started</Link>
      </Button>
    </Flex>
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
    <Flex direction="column" align="center" gap="4">
      <Heading size="4" style={{ textAlign: 'center', width: '100%' }}>
        Setup could not be saved
      </Heading>
      <Text size="2" style={{ textAlign: 'center', width: '100%' }}>
        {error}
      </Text>
      <Button variant="classic" size="2" asChild>
        <Link to="/done">Back</Link>
      </Button>
    </Flex>
  )
}

function Welcome(): JSX.Element {
  return (
    <WindowFrame windowType="app">
      <Container size="1">
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
      </Container>
    </WindowFrame>
  )
}

export default Welcome
