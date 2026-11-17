/**
 * The overlay's lookup key as it works on this machine (`overlayLookupKey` through
 * `effectiveLookupKey`): a mouse button where none can be read is Shift, as native reads it.
 */
import { effectiveLookupKey, type LookupKey } from '@ui/lookup-key'
import { useCapabilities } from './capabilities'
import { useSetting } from './useSetting'

export function useLookupKey(): LookupKey {
  const [stored] = useSetting<string>('overlayLookupKey', 'shift')
  const capabilities = useCapabilities()
  return effectiveLookupKey(stored, capabilities.keys.lookupButtons)
}
