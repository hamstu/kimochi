/** A reading profile is separate from the whole-screen capture stream. */
import { useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Dialog, DialogContent, Input } from "@kit";
import { useViewState } from "../bridge/state";

export function GamingApplicationProfile(): JSX.Element | null {
  const { state: view } = useViewState();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = view.applicationContext ?? view.source?.applicationContext;
  useEffect(() => {
    let alive = true;
    void invoke<{ available: boolean }>("application_context_get")
      .then((result) => {
        if (alive) setAvailable(result.available);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!available) return null;
  const save = async (automatic: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const value = name.trim();
      if (!automatic && (!value || [...value].length > 40))
        throw Error("Enter a profile name of up to 40 characters.");
      const encoded = btoa(
        String.fromCharCode(...new TextEncoder().encode(value)),
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await invoke("application_context_set", {
        context: automatic ? null : { id: `manual:${encoded}`, name: value },
      });
      setOpen(false);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="src-controls">
      <p>
        Game profile: <strong>{current?.name ?? "No game detected"}</strong>{" "}
        {current?.manual ? "(manual)" : "(automatic)"}
      </p>
      <Button
        onClick={() => {
          setName(current?.name ?? "");
          setError(null);
          setOpen(true);
        }}
      >
        Change game profile
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Game profile"
          description="Automatic profiles remember the crop and reading session for each game. Use a named profile for an emulator or a game that is not detected. Screen sharing stays the same."
          footer={
            <>
              <Button disabled={busy} onClick={() => void save(true)}>
                Use detected game
              </Button>
              <Button
                variant="primary"
                disabled={busy || !name.trim()}
                onClick={() => void save(false)}
              >
                Use named profile
              </Button>
            </>
          }
        >
          <label>
            Profile name
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
