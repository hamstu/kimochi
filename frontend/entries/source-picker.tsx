/**
 * Source-picker window entry.
 *
 * Mounts the coordinator-owned `frontend/source-picker/SourcePicker.tsx` — that component owns its
 * own `.source-picker`-scoped styling and talks to the native backend directly, so this file adds
 * nothing but the window it lives in: the shared theme providers (so it follows the system light or
 * dark theme like every other window) and the full-height reset its flex layout needs. No panel
 * title bar: the picker draws its own chrome.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@radix-ui/themes/styles.css'
import './source-picker.css'
import Providers from './providers'
import SourcePicker from '../source-picker/SourcePicker'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <SourcePicker />
    </Providers>
  </StrictMode>
)
