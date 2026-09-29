import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { Button } from "@texthooker/components/ui/button";
import { probe } from "@texthooker/lib/yomitan";
import { getSettings } from "@texthooker/lib/settings";

type InstallStatus = "idle" | "installing" | "success" | "error";

interface Props {
  yomitanUrl: string;
}

/**
 * Compact embedded version of remoki's YomitanSetupWizard. Lives inside the
 * Sources group of SettingsPanel. Polls the Yomitan API once a second so the
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
    <div className="rounded-md border border-(--color-border) bg-(--color-bg-elev)/40 p-2.5">
      {/* Status row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          {connected === null ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-(--color-text-muted)" />
          ) : connected ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-(--color-ok)" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-(--color-danger)" />
          )}
          <span>
            {connected === null
              ? "Checking…"
              : connected
                ? "API connected"
                : "API not reachable"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="text-(--color-accent)"
        >
          {expanded ? "Hide setup" : connected ? "Setup details" : "Set up"}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-3 text-xs text-(--color-text-dim)">
          {/* Step 1 — enable in Yomitan */}
          <div>
            <div className="mb-1 font-medium text-(--color-text)">
              1. Enable the API in Yomitan
            </div>
            <ol className="ml-4 list-decimal space-y-1">
              <li>Open the Yomitan extension settings in your browser.</li>
              <li>
                Toggle <span className="text-(--color-text)">Advanced</span> on
                (bottom left).
              </li>
              <li>
                Under <span className="text-(--color-text)">General</span>,
                enable <span className="text-(--color-text)">Yomitan API</span>.
              </li>
            </ol>
          </div>

          {/* Step 2 — install native host */}
          <div>
            <div className="mb-1 font-medium text-(--color-text)">
              2. Install native messaging host
            </div>
            <p className="mb-2">
              The host bridges the Yomitan browser extension to apps on your
              computer. Auto-installs from{" "}
              <span className="font-mono text-[0.625rem]">
                hamstu/go-yomitan-native-messaging-host
              </span>
              .
            </p>

            {installStatus === "idle" && (
              <div className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleInstall}
                  className="flex-1"
                >
                  Install
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenGithub}
                  title="Open GitHub for manual install"
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            )}

            {installStatus === "installing" && (
              <div className="flex items-center gap-2 text-(--color-text-muted)">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Downloading & installing…
              </div>
            )}

            {installStatus === "success" && (
              <div className="space-y-2">
                <div className="flex items-start gap-1.5 rounded-sm bg-(--color-ok)/10 px-2 py-1.5 text-[0.6875rem] text-(--color-ok)">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
                  <div>
                    Installed.
                    {installOutput && installOutput !== "Installed." ? (
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[0.625rem] opacity-80">
                        {installOutput}
                      </pre>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setInstallStatus("idle")}
                >
                  Reinstall
                </Button>
              </div>
            )}

            {installStatus === "error" && (
              <div className="space-y-2">
                <div className="rounded-sm bg-(--color-danger)/10 px-2 py-1.5 text-[0.6875rem] text-(--color-danger)">
                  <div className="font-medium">Install failed</div>
                  {installError ? (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[0.625rem] opacity-80">
                      {installError}
                    </pre>
                  ) : null}
                </div>
                <div className="flex gap-2">
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenGithub}
                    title="Manual install instructions"
                  >
                    Manual install <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Step 3 — restart browser */}
          <div>
            <div className="mb-1 font-medium text-(--color-text)">
              3. Restart your browser
            </div>
            <p>
              Fully quit and reopen your browser so Yomitan picks up the
              newly-installed host. The status above turns green when the
              connection is ready.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
