/**
 * Whether the last interaction was the keyboard. Menus return focus to their trigger only then,
 * so closing a menu with the mouse doesn't leave a focus ring behind.
 */
let lastInputKeyboard = false
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (lastInputKeyboard = true), true)
  window.addEventListener('pointerdown', () => (lastInputKeyboard = false), true)
}
export const closeAutoFocusFromKeyboardOnly = (event: Event): void => {
  if (!lastInputKeyboard) event.preventDefault()
}
