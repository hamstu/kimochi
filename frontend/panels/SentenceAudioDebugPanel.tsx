/**
 * Diagnostics → Sentence audio: what the listener (src-tauri/src/sentence_audio) knows, to see
 * why a line got its voice or did not. The recording and the speech model, how far behind the
 * listening and transcribing are, the newest lines with what was decided for each and why, and
 * what the recogniser heard lately. Polled once a second while the tab is shown.
 */
import { useEffect, useState, type JSX } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Bar, BarSpacer } from '@kit'
import WindowFrame from '../components/WindowFrame'
import './diagnostics.css'
import type { SentenceAudioStatus } from '@texthooker/lib/sentenceAudio'

const REFRESH_MS = 1000

interface LineReport {
  uid: string
  text: string
  ts: number
  appeared: number | null
  scan: string | null
  outcome: 'waiting' | 'voiced' | 'silent' | 'missed'
  how: 'matched' | 'timed' | null
  score: number | null
  heard: string | null
  clip: [number, number] | null
  provisional: boolean
  window: [number, number] | null
  decidedAt: number | null
  changes: number
  note: string
}

interface Debug {
  status: SentenceAudioStatus
  clips: number
  listener: {
    heardUntil: number | null
    transcribedUntil: number | null
    speaking: boolean
    speechDetection: boolean
    recogniser: boolean
    lines: LineReport[]
    heard: { startMs: number; endMs: number; text: string }[]
  } | null
}

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** `ms` relative to `base`, in seconds with a sign. */
const rel = (ms: number, base: number): string => `${ms >= base ? '+' : '−'}${(Math.abs(ms - base) / 1000).toFixed(1)}s`

const behind = (until: number | null | undefined): string =>
  until == null ? '—' : `${Math.max(0, (Date.now() - until) / 1000).toFixed(1)}s behind`

function outcome(line: LineReport): { label: string; tone: string } {
  if (line.outcome === 'voiced') {
    return line.how === 'matched'
      ? { label: `matched ${Math.round((line.score ?? 0) * 100)}%`, tone: 'good' }
      : { label: 'by timing', tone: 'info' }
  }
  if (line.outcome === 'waiting') return { label: 'waiting', tone: 'warn' }
  if (line.outcome === 'missed') return { label: 'missed', tone: 'bad' }
  return { label: 'no voice', tone: 'muted' }
}

export default function SentenceAudioDebugPanel(): JSX.Element {
  const [debug, setDebug] = useState<Debug | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = (): void => {
      invoke<Debug>('sentence_audio_debug').then(
        (value) => {
          if (!active) return
          setDebug(value)
          setError(null)
        },
        (e: unknown) => active && setError(String(e))
      )
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const status = debug?.status
  const listener = debug?.listener
  const recogniser = status?.recogniser
  return (
    <WindowFrame>
      <Bar position="top" className="diag-bar diag-bar-text">
        <span className="k-medium">Sentence audio</span>
        <BarSpacer />
        <span className="k-num">Refreshes every {REFRESH_MS / 1000}s</span>
      </Bar>
      <div className="diag-terminal diag-scroll sa-debug">
        {error && <div className="sa-bad">{error}</div>}
        {status && (
          <div className="sa-facts">
            <span>
              <b>recording</b> {status.state}
              {status.state === 'recording' && ` · ${status.source}`}
              {'message' in status && ` · ${status.message}`}
            </span>
            <span>
              <b>held</b> {status.held.toFixed(0)}s · <b>level</b> {Math.round(status.level * 100)}%
            </span>
            <span>
              <b>speech model</b> {recogniser?.state}
              {recogniser?.state === 'failed' && ` · ${recogniser.message}`}
            </span>
            <span>
              <b>clips kept</b> {debug.clips}
            </span>
            {listener && (
              <>
                <span>
                  <b>speech detection</b> {listener.speechDetection ? 'on' : 'off (timing only)'}
                  {listener.speaking && <span className="sa-warn"> · speech now</span>}
                </span>
                <span>
                  <b>listening</b> {behind(listener.heardUntil)}
                  {listener.recogniser && (
                    <>
                      {' '}· <b>transcribed</b> {behind(listener.transcribedUntil)}
                    </>
                  )}
                </span>
              </>
            )}
            {status.last && (
              <span className={status.last.ok ? undefined : 'sa-bad'}>
                <b>last card</b> {clock(status.last.at)} · {status.last.message}
              </span>
            )}
          </div>
        )}
        {status && !listener && <div className="sa-muted">Not listening: turn on Sentence Audio in Settings → Anki.</div>}
        {listener && (
          <>
            <div className="sa-heading">Lines, newest first</div>
            {listener.lines.length === 0 && <div className="sa-muted">No line since recording started.</div>}
            {listener.lines.map((line, i) => {
              const { label, tone } = outcome(line)
              const sameScan = line.scan != null && listener.lines[i - 1]?.scan === line.scan
              return (
                <div key={line.uid} className={sameScan ? 'sa-line sa-same-scan' : 'sa-line'}>
                  <div className="sa-line-head">
                    <span className="sa-muted k-num">{clock(line.ts)}</span>
                    <span className={`sa-${tone}`}>{label}</span>
                    {line.provisional && <span className="sa-muted">provisional</span>}
                    {line.clip && (
                      <span className="sa-muted k-num">
                        clip {rel(line.clip[0], line.ts)} to {rel(line.clip[1], line.ts)}
                      </span>
                    )}
                    {line.appeared != null && (
                      <span className="sa-muted k-num">appeared {rel(line.appeared, line.ts)}</span>
                    )}
                    {line.changes > 1 && <span className="sa-muted">decided {line.changes}×</span>}
                  </div>
                  <div className="sa-text">{line.text}</div>
                  {line.note && <div className="sa-muted">{line.note}</div>}
                </div>
              )
            })}
            {listener.recogniser && (
              <>
                <div className="sa-heading">Heard in the last minute</div>
                {listener.heard.length === 0 && <div className="sa-muted">Nothing yet.</div>}
                {listener.heard.map((h) => (
                  <div key={h.startMs} className="sa-heard">
                    <span className="sa-muted k-num">{clock(h.startMs)}</span> {h.text}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </WindowFrame>
  )
}
