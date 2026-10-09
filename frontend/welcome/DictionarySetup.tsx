import { useEffect, useState, type JSX } from "react";
import { Button } from "@kit";
import { Link } from "react-router";

type Job = {
  id: string;
  stage: string;
  title?: string;
  error?: string;
  entries?: number;
  progress?: { index?: number; count?: number };
};
async function request<T>(params: object): Promise<T> {
  const host = (
    window as unknown as {
      __extensionHost?: { toBackend: (message: object) => Promise<T> };
    }
  ).__extensionHost;
  if (!host)
    throw Error(
      "Dictionary setup is unavailable. Open dictionary settings or retry after Kimochi finishes starting.",
    );
  return host.toBackend({ action: "__setupDictionaries", params });
}
export default function DictionarySetup(): JSX.Element {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<
    { id: string; title: string; description: string }[]
  >([]);
  useEffect(() => {
    void request<{ catalog: typeof catalog }>({ command: "catalog" })
      .then((result) => setCatalog(result.catalog))
      .catch((caught) => setError(String(caught)));
  }, []);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!job || ["complete", "failed"].includes(job.stage)) return;
    let active = true;
    const timer = setInterval(() => {
      void request<Job>({ command: "status", id: job.id })
        .then((next) => {
          if (active) {
            setJob(next);
            setError(null);
          }
        })
        .catch((caught) => {
          if (active) setError(String(caught));
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job]);
  const start = async (dictionaryId: string): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const result = await request<{ id: string }>({
        command: "start",
        dictionaryId,
      });
      setJob({ ...result, stage: "starting" });
    } catch (caught) {
      setError(String(caught));
    } finally {
      setStarting(false);
    }
  };
  const busy =
    starting || (job !== null && !["complete", "failed"].includes(job.stage));
  return (
    <section aria-labelledby="dictionary-setup-title">
      <h1 id="dictionary-setup-title">Definitions, ready to read</h1>
      <p>
        Kimochi includes Yomitan. You do not need to install a browser
        extension.
      </p>
      <p>
        Quick setup downloads Jitendex, a Japanese–English dictionary, and
        enables it in your current profile. Existing dictionaries and
        preferences are kept. An internet connection is needed for the download.
      </p>
      {catalog.map((item) => (
        <div key={item.id}>
          <p>
            <strong>{item.title}</strong> — {item.description}
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void start(item.id)}
          >
            Set up {item.title}
          </Button>
        </div>
      ))}
      {job && (
        <p role="status">
          {job.stage === "complete"
            ? `${job.title} is installed and enabled (${job.entries?.toLocaleString()} entries).`
            : `Dictionary setup: ${job.stage}. You can leave this page; the job continues while Kimochi runs.`}
        </p>
      )}
      {job?.stage === "importing" && (job.progress?.count ?? 0) > 0 && (
        <progress
          aria-label="Dictionary import progress"
          value={job.progress?.index ?? 0}
          max={job.progress?.count}
        />
      )}
      {(error || job?.error) && <p role="alert">{error || job?.error}</p>}
      <p>
        Already have dictionaries or a Yomitan settings backup? Import them in
        Kimochi’s dictionary settings. Settings backups and dictionary ZIP
        archives are separate imports.
      </p>
      <Button asChild>
        <Link to="/dictionary-settings">Import or manage dictionaries</Link>
      </Button>{" "}
      <Button asChild>
        <Link to="/practice">
          {busy ? "Continue while importing" : "Continue"}
        </Link>
      </Button>
    </section>
  );
}

export function DictionaryPractice(): JSX.Element {
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function check(): Promise<void> {
    setPending(true);
    try {
      const found = await request<{ text: string; matches: number }>({
        command: "practice",
      });
      setResult(
        found.matches > 0
          ? `${found.text}: ${found.matches} dictionary results found. Your dictionary is ready.`
          : "No definitions found yet. Finish importing and enable a Japanese dictionary in dictionary settings.",
      );
    } catch (error) {
      setResult(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <Button
        disabled={pending}
        onClick={() => {
          void check();
        }}
      >
        {pending ? "Checking…" : "Test 日本語 lookup"}
      </Button>
      {result && <p role="status">{result}</p>}
    </div>
  );
}
