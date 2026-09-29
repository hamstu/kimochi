import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { ExternalLink } from "lucide-react";
import { Button, Callout, IconButton, SettingsRow, Spinner, StatusDot } from "@kit";
import { probe } from "@texthooker/lib/yomitan";
import { getSettings } from "@texthooker/lib/settings";

type InstallStatus = "idle" | "installing" | "success" | "error";

interface Props {
  yomitanUrl: string;
}

/**
 * Compact embedded version of remoki's YomitanSetupWizard, rendered as settings
 * rows inside a SettingsSection (not currently mounted). Polls the Yomitan API once a second so the
 * "connected" badge reflects reality without the user lifting a finger.
 */
export function YomitanSetup({ yomitanUrl }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus>("idle");
  const [installError, setInstallError] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const url = getSettings().yomitanApiUrl;
      const res = await probe(url);
      if (cancelled) return;
      setConnected(res.ok);
    };
    void check();
    intervalRef.current = setInterval(check, 2000);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [yomitanUrl]);

  const handleInstall = async () => {
    setInstallStatus("installing");
    setInstallError(null);
    setInstallOutput(null);
    try {
      const out = await invoke<string>("install_yomitan_native_host");
      setInstallStatus("success");
      setInstallOutput(out.trim() || "Installed.");
    } catch (err) {
      setInstallStatus("error");
      setInstallError(String(err));
    }
  };

  const handleOpenGithub = () => {
    void openUrl(
      "https://github.com/hamstu/go-yomitan-native-messaging-host#readme",
    );
  };

  return (
    <>
      <SettingsRow
        label={
          <>
            {connected === null ? (
              <Spinner label="Checking" />
            ) : (
              <StatusDot tone={connected ? "ok" : "danger"} />
            )}
            {connected === null
              ? "Checking…"
              : connected
                ? "API connected"
                : "API not reachable"}
          </>
        }
      >
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Hide setup" : connected ? "Setup details" : "Set up"}
        </Button>
      </SettingsRow>

      {expanded ? (
        <>
          <SettingsRow
            stacked
            label="1. Enable the API in Yomitan"
            description={
              <>
                Open the Yomitan extension settings in your browser, turn on{" "}
                <b>Advanced</b> (bottom left), then under <b>General</b> enable{" "}
                <b>Yomitan API</b>.
              </>
            }
          />

          <SettingsRow
            stacked
            label="2. Install native messaging host"
            description={
              <>
                The host bridges the Yomitan browser extension to apps on your computer.
                Auto-installs from{" "}
                <span className="k-mono">hamstu/go-yomitan-native-messaging-host</span>.
              </>
            }
          >
            {installStatus === "idle" && (
              <>
                <Button size="sm" onClick={() => void handleInstall()}>
                  Install
                </Button>
                <IconButton label="Open GitHub for manual install" size="sm" onClick={handleOpenGithub}>
                  <ExternalLink />
                </IconButton>
              </>
            )}

            {installStatus === "installing" && (
              <span className="k-description">
                <Spinner label="Installing" /> Downloading and installing…
              </span>
            )}

            {installStatus === "success" && (
              <>
                <Callout tone="ok">
                  <span>Installed.</span>
                  {installOutput && installOutput !== "Installed." ? (
                    <pre className="texthooker-pre">{installOutput}</pre>
                  ) : null}
                </Callout>
                <Button variant="ghost" size="sm" onClick={() => setInstallStatus("idle")}>
                  Reinstall
                </Button>
              </>
            )}

            {installStatus === "error" && (
              <>
                <Callout tone="danger">
                  <span className="k-medium">Install failed</span>
                  {installError ? <pre className="texthooker-pre">{installError}</pre> : null}
                </Callout>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setInstallStatus("idle");
                    setInstallError(null);
                  }}
                >
                  Try again
                </Button>
                <Button variant="ghost" size="sm" onClick={handleOpenGithub}>
                  Manual install <ExternalLink />
                </Button>
              </>
            )}
          </SettingsRow>

          <SettingsRow
            stacked
            label="3. Restart your browser"
            description="Fully quit and reopen your browser so Yomitan picks up the newly installed host. The status above turns green when the connection is ready."
          />
        </>
      ) : null}
    </>
  );
}
