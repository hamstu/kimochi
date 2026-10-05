// explain.rs — run a local LLM CLI (codex or claude) to explain a sentence,
// streaming output back to the frontend as events.
//
// Commands are spawned through `platform::run_cli`, which on macOS goes through
// `zsh -ilc` so the user's interactive shell PATH applies (fnm/nvm shims and
// ~/.local/bin live in .zshrc, which plain login shells don't read). The prompt
// is passed via stdin, never argv, so no shell-quoting of user text is needed.
//
// Events (all carry the requestId they belong to so stale runs are ignored):
//   explain:chunk { requestId, text }  — incremental text (claude streams
//                                        tokens; codex sends whole messages)
//   explain:done  { requestId, text }  — full final markdown
//   explain:error { requestId, text }  — human-readable failure

use serde::Serialize;
use serde_json::Value;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::sync::Mutex;

/// The requestId of the run whose events are still wanted. A new run (or a
/// cancel) replaces it, after which the superseded run stops emitting.
static ACTIVE_REQUEST: AtomicU64 = AtomicU64::new(0);
/// The running CLI process, tagged with the requestId that spawned it so a
/// superseded run never waits on (or kills) a newer run's child.
static CHILD: Mutex<Option<(u64, Child)>> = Mutex::const_new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExplainEvent {
    request_id: u64,
    text: String,
}

fn emit(app: &AppHandle, event: &str, request_id: u64, text: String) {
    let _ = app.emit(event, ExplainEvent { request_id, text });
}

/// Kill a CLI and reap it off the async runtime, so a cancelled run never
/// lingers as a zombie.
fn stop(mut child: Child) {
    let _ = child.kill();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// Model names are interpolated into a shell string, so restrict them to
/// characters that can never escape quoting.
fn validate_model(model: &str) -> Result<(), String> {
    if model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(())
    } else {
        Err(format!("invalid model name: {model}"))
    }
}

async fn kill_current() {
    let mut guard = CHILD.lock().await;
    if let Some((_, child)) = guard.take() {
        stop(child);
    }
}

/// Remove and kill this run's child, leaving a newer run's child untouched.
async fn kill_own(request_id: u64) {
    let mut guard = CHILD.lock().await;
    match guard.take() {
        Some((id, child)) if id == request_id => stop(child),
        other => *guard = other,
    }
}

#[tauri::command]
pub async fn explain_cancel() -> Result<(), String> {
    ACTIVE_REQUEST.store(0, Ordering::SeqCst);
    kill_current().await;
    Ok(())
}

#[tauri::command]
pub async fn explain_run(
    app: AppHandle,
    request_id: u64,
    provider: String,
    model: Option<String>,
    prompt: String,
) -> Result<(), String> {
    let model = model.unwrap_or_default();
    if !model.is_empty() {
        validate_model(&model)?;
    }

    let (program, args): (&str, Vec<&str>) = match provider.as_str() {
        "codex" => {
            // --json: JSONL events; the answer arrives as item.completed /
            // agent_message. `-` reads the prompt from stdin. read-only
            // sandbox: this is a pure text task, the agent needs no writes.
            let mut args = vec![
                "exec",
                "--skip-git-repo-check",
                "-s",
                "read-only",
                "--color",
                "never",
                "--json",
            ];
            if !model.is_empty() {
                args.extend(["-m", model.as_str()]);
            }
            args.push("-");
            ("codex", args)
        }
        "claude" => {
            // stream-json + partial messages gives token-level deltas.
            // --strict-mcp-config skips the user's MCP servers (slow startup,
            // irrelevant here). --verbose is required for stream-json in -p.
            let mut args = vec![
                "-p",
                "--verbose",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--strict-mcp-config",
            ];
            if !model.is_empty() {
                args.extend(["--model", model.as_str()]);
            }
            ("claude", args)
        }
        other => return Err(format!("unknown explain provider: {other}")),
    };

    // Take over as the active run; the previous CLI (if any) is killed when
    // we claim the child slot below.
    ACTIVE_REQUEST.store(request_id, Ordering::SeqCst);

    // The prompt is fed on stdin, which is closed afterwards so the CLI starts.
    // Neutral cwd: keeps claude from loading a project's CLAUDE.md/hooks and
    // codex from scanning a repo.
    let mut child = crate::platform::run_cli(
        program,
        &args,
        Some(&prompt),
        Some(&std::env::temp_dir()),
    )
    .map_err(|e| format!("failed to spawn {provider}: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("stdout unavailable")
        .and_then(|out| ChildStdout::from_std(out).map_err(|_| "stdout unavailable"));
    let stderr = child
        .stderr
        .take()
        .ok_or("stderr unavailable")
        .and_then(|err| ChildStderr::from_std(err).map_err(|_| "stderr unavailable"));
    let (stdout, mut stderr) = match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => (stdout, stderr),
        (Err(e), _) | (_, Err(e)) => {
            stop(child);
            return Err(e.into());
        }
    };

    {
        // Atomically replace (and kill) whatever was running before.
        let mut guard = CHILD.lock().await;
        if let Some((_, old)) = guard.take() {
            stop(old);
        }
        *guard = Some((request_id, child));
    }

    let is_current = || ACTIVE_REQUEST.load(Ordering::SeqCst) == request_id;

    // Drain stderr concurrently so a chatty CLI can't deadlock on a full pipe.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let mut full = String::new();
    let mut claude_result: Option<String> = None;
    let mut lines = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue; // non-JSON noise (shell init warnings etc.)
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match provider.as_str() {
            "claude" => match ty {
                "stream_event" => {
                    let delta = v
                        .pointer("/event/delta")
                        .filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("text_delta"));
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        full.push_str(text);
                        if is_current() {
                            emit(&app, "explain:chunk", request_id, text.to_string());
                        }
                    }
                }
                "result" => {
                    // Authoritative full text (also covers runs where partial
                    // streaming was unavailable).
                    if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                        claude_result = Some(r.to_string());
                    }
                    if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
                        let msg = v
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("claude returned an error")
                            .to_string();
                        if is_current() {
                            emit(&app, "explain:error", request_id, msg);
                        }
                        let _ = stderr_task.await;
                        kill_own(request_id).await;
                        return Ok(());
                    }
                }
                _ => {}
            },
            _ => match ty {
                // codex
                "item.completed" => {
                    let item = v.get("item");
                    let is_msg = item.and_then(|i| i.get("type")).and_then(|t| t.as_str())
                        == Some("agent_message");
                    if is_msg {
                        if let Some(text) =
                            item.and_then(|i| i.get("text")).and_then(|t| t.as_str())
                        {
                            if !full.is_empty() {
                                full.push_str("\n\n");
                            }
                            full.push_str(text);
                            if is_current() {
                                emit(&app, "explain:chunk", request_id, text.to_string());
                            }
                        }
                    }
                }
                "error" => {
                    let msg = v
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("codex returned an error")
                        .to_string();
                    if is_current() {
                        emit(&app, "explain:error", request_id, msg);
                    }
                    let _ = stderr_task.await;
                    kill_own(request_id).await;
                    return Ok(());
                }
                _ => {}
            },
        }
    }

    let stderr_text = stderr_task.await.unwrap_or_default();
    // Reclaim OUR child (if a newer run replaced it, leave theirs alone) and
    // reap it outside the lock.
    let own_child = {
        let mut guard = CHILD.lock().await;
        match guard.take() {
            Some((id, child)) if id == request_id => Some(child),
            other => {
                *guard = other; // not ours — put it back
                None
            }
        }
    };
    let status = match own_child {
        Some(mut child) => tokio::task::spawn_blocking(move || child.wait())
            .await
            .ok()
            .and_then(Result::ok),
        None => None, // killed by a newer run / cancel
    };

    if !is_current() {
        return Ok(());
    }

    let final_text = claude_result.unwrap_or(full);
    if !final_text.trim().is_empty() {
        emit(&app, "explain:done", request_id, final_text);
    } else {
        let exit = status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "killed".into());
        // Skip zsh interactive-shell noise; keep the tail, where CLIs put
        // the actual error.
        let detail: String = stderr_text
            .lines()
            .filter(|l| !l.contains("can't change option"))
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .rev()
            .take(600)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        emit(
            &app,
            "explain:error",
            request_id,
            format!("{provider} produced no output ({exit}). {detail}")
                .trim()
                .to_string(),
        );
    }
    Ok(())
}
