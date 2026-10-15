import { Crop, Expand, ScanText, Settings } from 'lucide-react'
import { Button, IconButton, Switch, Tooltip } from '@kit'
import type { ControllerWiring } from '../panels/useController'
import { DictionaryPicker, OcrModel } from './MainSidebar'
import type { SettingsTabName } from '../bridge/tauri'

export function MiniPanel({ controller, onExpand, onSettings }: {
  controller: ControllerWiring['props']
  onExpand: () => void
  onSettings: (tab: SettingsTabName) => void
}) {
  return <div className="mini-panel">
    <div className="mini-source">
      <button className="mini-source-name" onClick={controller.onActivateSource}
        title={controller.currentSource?.name ?? 'Choose a source'}>
        {controller.currentSource?.name ?? 'No source selected'}
      </button>
      <Tooltip content="Expand Kimochi"><IconButton label="Expand Kimochi" onClick={onExpand}><Expand /></IconButton></Tooltip>
    </div>
    <OcrModel onOpenSettings={() => onSettings('ocr')} />
    <DictionaryPicker onOpenSettings={() => onSettings('dictionary')} />
    <div className="mini-controls">
      <Button variant="primary" disabled={!controller.hasSource || controller.isScanning}
        onClick={controller.onTriggerScan}><ScanText />{controller.isScanning ? 'Scanning…' : 'Scan'}</Button>
      <Tooltip content="Crop area"><IconButton label="Crop area" disabled={!controller.hasSource}
        onClick={controller.onEditCropArea}><Crop /></IconButton></Tooltip>
      <label className="mini-auto"><Switch checked={controller.isAutoOCREnabled}
        onCheckedChange={controller.onToggleAutoOCR} />Auto OCR</label>
      <Tooltip content="Settings"><IconButton label="Settings" onClick={() => onSettings('general')}><Settings /></IconButton></Tooltip>
    </div>
  </div>
}
