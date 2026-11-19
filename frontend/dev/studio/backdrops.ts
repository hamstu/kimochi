/**
 * DEV-ONLY: the backdrops screenshot mode puts behind a surface in the studio: plain patterns, and
 * gradients from dark to bright to near-white. Each is a CSS `background` value.
 */
export interface Backdrop {
  id: string
  label: string
  group: 'Patterns' | 'Dark' | 'Bright' | 'Light'
  background: string
  /** Size for the pattern layers, when the background repeats. */
  size?: string
}

const grid = (line: string, base: string, step = 32): Pick<Backdrop, 'background' | 'size'> => ({
  background: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px), ${base}`,
  size: `${step}px ${step}px, ${step}px ${step}px, auto`
})
const dots = (dot: string, base: string, step = 22): Pick<Backdrop, 'background' | 'size'> => ({
  background: `radial-gradient(${dot} 1.2px, transparent 1.6px), ${base}`,
  size: `${step}px ${step}px, auto`
})

export const BACKDROPS: readonly Backdrop[] = [
  // Patterns
  { id: 'grid-light', label: 'Grid, light', group: 'Patterns', ...grid('rgb(15 23 42 / 0.07)', '#f8fafc') },
  { id: 'grid-dark', label: 'Grid, dark', group: 'Patterns', ...grid('rgb(255 255 255 / 0.06)', '#0d1017') },
  {
    id: 'blueprint',
    label: 'Blueprint',
    group: 'Patterns',
    background:
      'linear-gradient(rgb(255 255 255 / 0.14) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.14) 1px, transparent 1px), linear-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.05) 1px, transparent 1px), #1d4ed8',
    size: '96px 96px, 96px 96px, 24px 24px, 24px 24px, auto'
  },
  { id: 'dots-light', label: 'Dots, light', group: 'Patterns', ...dots('rgb(15 23 42 / 0.18)', '#f5f5f4') },
  { id: 'dots-dark', label: 'Dots, dark', group: 'Patterns', ...dots('rgb(255 255 255 / 0.14)', '#111113') },
  {
    id: 'dots-glow',
    label: 'Dots on glow',
    group: 'Patterns',
    ...dots('rgb(255 255 255 / 0.16)', 'radial-gradient(80% 70% at 50% 40%, #3b2a78, #0c0a1c 70%)')
  },
  {
    id: 'diagonal',
    label: 'Diagonal lines',
    group: 'Patterns',
    background: 'repeating-linear-gradient(45deg, rgb(15 23 42 / 0.06) 0 1px, transparent 1px 12px), #fafaf9'
  },
  {
    id: 'checker',
    label: 'Transparency checker',
    group: 'Patterns',
    background: 'conic-gradient(#e5e7eb 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0)',
    size: '20px 20px'
  },

  // Dark gradients
  {
    id: 'midnight',
    label: 'Midnight',
    group: 'Dark',
    background:
      'radial-gradient(90% 70% at 20% 10%, #1e293b, transparent 60%), radial-gradient(80% 60% at 90% 100%, #1e1b4b, transparent 60%), #05060a'
  },
  {
    id: 'aurora',
    label: 'Aurora',
    group: 'Dark',
    background:
      'radial-gradient(60% 50% at 15% 20%, rgb(16 185 129 / 0.55), transparent 70%), radial-gradient(55% 45% at 80% 15%, rgb(99 102 241 / 0.55), transparent 70%), radial-gradient(70% 60% at 60% 100%, rgb(236 72 153 / 0.35), transparent 70%), #070b14'
  },
  {
    id: 'nebula',
    label: 'Nebula',
    group: 'Dark',
    background:
      'radial-gradient(50% 50% at 30% 30%, rgb(168 85 247 / 0.6), transparent 70%), radial-gradient(45% 45% at 75% 65%, rgb(59 130 246 / 0.5), transparent 70%), radial-gradient(30% 30% at 55% 40%, rgb(244 114 182 / 0.35), transparent 70%), #0a0614'
  },
  {
    id: 'ember',
    label: 'Ember',
    group: 'Dark',
    background:
      'radial-gradient(80% 60% at 50% 110%, rgb(249 115 22 / 0.7), transparent 65%), radial-gradient(60% 40% at 50% 100%, rgb(220 38 38 / 0.6), transparent 70%), #120806'
  },
  {
    id: 'deep-sea',
    label: 'Deep sea',
    group: 'Dark',
    background: 'linear-gradient(160deg, #0f2a3f 0%, #08151f 45%, #020608 100%)'
  },
  {
    id: 'forest-night',
    label: 'Forest night',
    group: 'Dark',
    background:
      'radial-gradient(70% 60% at 80% 20%, rgb(34 197 94 / 0.25), transparent 70%), linear-gradient(180deg, #0b1a12, #030805)'
  },
  {
    id: 'graphite',
    label: 'Graphite',
    group: 'Dark',
    background: 'linear-gradient(145deg, #2a2d34 0%, #16181d 55%, #0b0c0f 100%)'
  },

  // Bright gradients
  {
    id: 'sunset',
    label: 'Sunset',
    group: 'Bright',
    background: 'linear-gradient(135deg, #ff7a59 0%, #ff4d8d 45%, #7b5cff 100%)'
  },
  {
    id: 'candy',
    label: 'Candy',
    group: 'Bright',
    background:
      'radial-gradient(60% 60% at 0% 0%, #ffd1f0, transparent 70%), radial-gradient(60% 60% at 100% 0%, #c2e9ff, transparent 70%), radial-gradient(70% 70% at 50% 100%, #ffb3c7, transparent 70%), #f3d9ff'
  },
  {
    id: 'ocean',
    label: 'Ocean',
    group: 'Bright',
    background: 'linear-gradient(135deg, #00c6ff 0%, #0072ff 55%, #4f2bd8 100%)'
  },
  {
    id: 'citrus',
    label: 'Citrus',
    group: 'Bright',
    background: 'linear-gradient(135deg, #f9f871 0%, #a8e063 45%, #22c1a4 100%)'
  },
  {
    id: 'peach',
    label: 'Peach',
    group: 'Bright',
    background: 'linear-gradient(160deg, #ffecd2 0%, #fcb69f 100%)'
  },
  {
    id: 'sakura',
    label: 'Sakura',
    group: 'Bright',
    background:
      'radial-gradient(70% 60% at 20% 20%, #ffe4ec, transparent 70%), radial-gradient(60% 60% at 90% 80%, #ff9ec4, transparent 70%), #ffc8dc'
  },
  {
    id: 'mesh',
    label: 'Rainbow mesh',
    group: 'Bright',
    background:
      'radial-gradient(45% 55% at 10% 20%, #ff6b9d, transparent 70%), radial-gradient(45% 55% at 90% 15%, #ffc75f, transparent 70%), radial-gradient(50% 55% at 85% 90%, #4dd4ff, transparent 70%), radial-gradient(50% 55% at 15% 90%, #845ec2, transparent 70%), #f9a8d4'
  },

  // Light grays
  { id: 'paper', label: 'Paper', group: 'Light', background: 'linear-gradient(180deg, #ffffff 0%, #f4f4f2 100%)' },
  {
    id: 'fog',
    label: 'Fog',
    group: 'Light',
    background:
      'radial-gradient(80% 70% at 50% 0%, #ffffff, transparent 70%), linear-gradient(180deg, #eef0f3, #dfe3e8)'
  },
  {
    id: 'pearl',
    label: 'Pearl',
    group: 'Light',
    background:
      'radial-gradient(60% 60% at 15% 15%, #fdf2f8, transparent 70%), radial-gradient(60% 60% at 85% 85%, #eef2ff, transparent 70%), #f8fafc'
  },
  {
    id: 'silver',
    label: 'Silver',
    group: 'Light',
    background: 'linear-gradient(145deg, #fafafa 0%, #e4e4e7 60%, #d4d4d8 100%)'
  },
  {
    id: 'studio-white',
    label: 'Studio white',
    group: 'Light',
    background: 'radial-gradient(90% 80% at 50% 40%, #ffffff 40%, #e7e7ea 100%)'
  }
]

export const backdropOf = (id: string | undefined): Backdrop =>
  BACKDROPS.find((b) => b.id === id) ?? BACKDROPS.find((b) => b.id === 'aurora')!
