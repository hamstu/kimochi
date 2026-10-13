import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router";
import { CheckCircle2Icon, ChevronLeft, ExternalLinkIcon } from "lucide-react";
import { Bar, Button, IconButton } from "@kit";
import { openScreenCapturePreferences, useSystemPick } from "../bridge/tauri";
import { motion } from "motion/react";

import { usePanelController } from "../shell/usePanelController";
import AnimationLayout from "./AnimationLayout";
import WindowFrame from "../components/WindowFrame";
import macOSScreenPerms from "./assets/howto-screen-macos.png";

import DictionarySetup, { DictionaryPractice } from "./DictionarySetup";
import EngineSetup from "./EngineSetup";
import { useExtensionStatus } from "../bridge/extensions";
import { useDictionaryEngine } from "../bridge/dictionaryEngine";
import { Callout } from "@kit";
import DictionarySettingsPanel from "../panels/DictionarySettingsPanel";
import { EngineChooser } from "../panels/settings/EngineChooser";
import svgLogo from "./assets/kimochi-logo.svg";
import style from "./WelcomeApp.module.css";

import {
  useCaptureStep,
  useHasScreenRecordingPermission,
} from "./useHasScreenRecordingPermission";
import { useCapabilities } from "../bridge/capabilities";
import { SystemPickerButton } from "../main/SourceGrid";
import { completeOnboarding, resizeWelcome } from "./welcome-actions";

/** Setup can be revisited without changing choices already made. */
const BACK: Record<string, string> = {
  "/ocr": "/",
  "/engine": "/ocr",
  "/dictionaries": "/engine",
  "/practice": "/dictionaries",
  "/dictionary-settings": "/dictionaries",
  "/screen-recording-permission": "/",
  "/system-picker": "/",
  "/done": "/practice",
};

/** One onboarding step: art, an xl heading, a paragraph and the step's actions. */
function Step({
  art,
  title,
  children,
  actions,
  wide = false,
}: {
  art: ReactNode;
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  wide?: boolean;
}): JSX.Element {
  return (
    <div className={wide ? `${style.step} ${style.wide}` : style.step}>
      <div className={style.art}>{art}</div>
      <h1 className={style.title}>{title}</h1>
      <p className={style.body}>{children}</p>
      <div className={style.actions}>{actions}</div>
    </div>
  );
}

function InitialScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500);
  }, []);
  const captureStep = useCaptureStep();
  const gaming =
    useCapabilities().session?.compositor?.toLowerCase() === "gamescope";
  const next = gaming
    ? "/ocr"
    : captureStep === "permission"
      ? "/screen-recording-permission"
      : captureStep === "picker"
        ? "/system-picker"
        : "/ocr";
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
          <Link to={next}>Get Started</Link>
        </Button>
      }
    >
      Kimochi is a tool to help you read and understand Japanese on your
      computer (like in games or other visual content). It looks like this is
      your first run, so let&apos;s get you set up.
    </Step>
  );
}

function ScreenPermissionScreen(): JSX.Element {
  const hasPermission = useHasScreenRecordingPermission();
  const { restartAfterGrant } = useCapabilities().capture;
  useEffect(() => {
    resizeWelcome(800);
  }, []);
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
            <Link to="/ocr">Continue</Link>
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              void openScreenCapturePreferences();
            }}
          >
            Open Settings <ExternalLinkIcon />
          </Button>
        )
      }
    >
      Kimochi needs screen recording permission to capture and OCR text from
      your screen. Please click the button below to open your system settings
      and grant access.
      {restartAfterGrant
        ? " On macOS, you may need to restart Kimochi after granting the permission."
        : ""}
    </Step>
  );
}

/**
 * Where the system asks what to share (a portal picker): nothing to grant up front, but the
 * screen or window can be chosen here already, through the same button the sidebar offers.
 */
function SystemPickerScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(560);
  }, []);
  const { picked } = useSystemPick();
  const pickedName = picked ? picked.app || picked.name || "your screen" : null;
  return (
    <Step
      art={<img src={svgLogo} alt="Kimochi" width={160} />}
      title="Choosing What to Read"
      actions={
        <>
          {!picked && <SystemPickerButton />}
          <Button variant={picked ? "primary" : "secondary"} asChild>
            <Link to="/ocr">{picked ? "Continue" : "Choose later"}</Link>
          </Button>
        </>
      }
    >
      {pickedName
        ? `Kimochi will read ${pickedName}. You can choose again at any time from the sidebar's Change source menu.`
        : "You choose what Kimochi reads in the system picker: your desktop asks you to confirm the screen or window to share. Choose the game or app you want to read now, or later from the sidebar."}
    </Step>
  );
}

function OcrScreen(): JSX.Element {
  return (
    <section>
      <h1>Choose how to recognize text</h1>
      <p>
        Local engines keep scans on this device. Cloud engines need a connection
        and may require credentials. You can change this later in Settings.
      </p>
      <EngineChooser />
      <Button variant="primary" asChild>
        <Link to="/engine">Continue</Link>
      </Button>
    </section>
  );
}

/**
 * Whether the dictionary the setting names can be used: its download (Kimochi's pop-up needs
 * Yomitan's) is ready. Null until native answers (and on a backend without engine downloads).
 */
function useDictionaryReady(): boolean | null {
  const [engine] = useDictionaryEngine();
  const status = useExtensionStatus(engine === "custom-api" ? "yomitan" : engine);
  return status ? status.state === "ready" : null;
}

/** Said on the last steps when onboarding goes on without a dictionary (the engine step skipped). */
function NoDictionaryWarning(): JSX.Element | null {
  const ready = useDictionaryReady();
  if (ready !== false) return null;
  return (
    <Callout tone="warn">
      No dictionary is set up, so nothing will look words up yet. Choose and
      download one in Settings → Dictionary whenever you are ready.
    </Callout>
  );
}

function PracticeScreen(): JSX.Element {
  const capabilities = useCapabilities();
  const gaming =
    capabilities.os === "linux" &&
    capabilities.session?.compositor?.toLowerCase() === "gamescope";
  return (
    <section>
      <h1>Read, look up, keep playing</h1>
      <NoDictionaryWarning />
      <DictionaryPractice />
      <ol>
        <li>
          {gaming
            ? "Gaming Mode shares the game screen automatically. Set a crop around the dialogue to ignore menus and other text."
            : "Choose the game or screen in the source selector, then crop the area you want to read."}
        </li>
        <li>Run Scan to recognize Japanese text.</li>
        <li>
          Hover a word while holding Shift, or use controller reading
          navigation, to show definitions.
        </li>
        <li>Use B to leave controller reading and return to your game.</li>
      </ol>
      <p>
        Try looking up 日本語 after your dictionary is ready. You can revisit
        OCR and dictionary settings whenever you need.
      </p>
      <Button variant="primary" asChild>
        <Link to="/done">Finish setup</Link>
      </Button>
    </section>
  );
}

function DoneScreen(): JSX.Element {
  useEffect(() => {
    resizeWelcome(500);
  });
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
        <>
          <NoDictionaryWarning />
          <Button variant="primary" asChild>
            <Link to="/main">Get Started</Link>
          </Button>
        </>
      }
    >
      You&apos;re all set up! Click the button below to close this window and
      start using Kimochi. If you need to change any settings later, you can
      always do so from the Kimochi preferences.
    </Step>
  );
}

function CompleteOnboarding(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    completeOnboarding().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, []);
  if (!error) return <></>;
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
  );
}

function Welcome(): JSX.Element {
  usePanelController("welcome");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const back = BACK[pathname];
  useEffect(() => {
    const cancel = (event: Event): void => {
      if (back) {
        event.preventDefault();
        void navigate(back);
      }
    };
    document.addEventListener("kimochi:controller-back", cancel);
    return () =>
      document.removeEventListener("kimochi:controller-back", cancel);
  }, [back, navigate]);
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
            <Route
              path="/screen-recording-permission"
              element={<ScreenPermissionScreen />}
            />
            <Route path="/system-picker" element={<SystemPickerScreen />} />
            <Route path="/ocr" element={<OcrScreen />} />
            <Route path="/engine" element={<EngineSetup />} />
            <Route path="/dictionaries" element={<DictionarySetup />} />
            <Route
              path="/dictionary-settings"
              element={
                <section
                  style={{
                    height: "65vh",
                    display: "flex",
                    flexDirection: "column",
                  }}
                  aria-label="Import or manage dictionaries"
                >
                  <DictionarySettingsPanel />
                </section>
              }
            />
            <Route path="/practice" element={<PracticeScreen />} />
            <Route path="/done" element={<DoneScreen />} />
            <Route path="/main" element={<CompleteOnboarding />} />
          </Route>
        </Routes>
      </main>
    </WindowFrame>
  );
}

export default Welcome;
