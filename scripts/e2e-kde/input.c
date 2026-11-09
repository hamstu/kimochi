// rig-input: drive KWin's org_kde_kwin_fake_input from argv (test rig only; KWin offers it to any
// client when started with KWIN_WAYLAND_NO_PERMISSION_CHECKS=1).
//   move X Y | click [left|right|middle] | down/up [button] | key CODE | keydown CODE | keyup CODE
//   | wheel DY | sleep MS
// Commands run in order, e.g. `rig-input move 500 300 click` or `rig-input keydown 42 key 66 keyup 42`
// (Shift+F8). Coordinates are logical (compositor) pixels; key codes are evdev's.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <linux/input-event-codes.h>
#include <wayland-client.h>
#include "fake-input-client.h"
static struct org_kde_kwin_fake_input *fake;
static void global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t v) {
  if (!strcmp(iface, org_kde_kwin_fake_input_interface.name))
    fake = wl_registry_bind(r, name, &org_kde_kwin_fake_input_interface, v < 4 ? v : 4);
}
static void global_remove(void *d, struct wl_registry *r, uint32_t n) {}
static const struct wl_registry_listener rl = {global, global_remove};
static uint32_t button(const char *s) {
  if (s && !strcmp(s, "right")) return BTN_RIGHT;
  if (s && !strcmp(s, "middle")) return BTN_MIDDLE;
  return BTN_LEFT;
}
int main(int argc, char **argv) {
  struct wl_display *dpy = wl_display_connect(NULL);
  if (!dpy) { fprintf(stderr, "no wayland display\n"); return 1; }
  struct wl_registry *reg = wl_display_get_registry(dpy);
  wl_registry_add_listener(reg, &rl, NULL);
  wl_display_roundtrip(dpy);
  if (!fake) { fprintf(stderr, "no org_kde_kwin_fake_input (KWIN_WAYLAND_NO_PERMISSION_CHECKS?)\n"); return 1; }
  org_kde_kwin_fake_input_authenticate(fake, "rig", "test harness");
  for (int i = 1; i < argc; i++) {
    const char *c = argv[i];
    const char *next = i + 1 < argc ? argv[i + 1] : NULL;
    int has_btn = next && (!strcmp(next, "left") || !strcmp(next, "right") || !strcmp(next, "middle"));
    if (!strcmp(c, "move") && i + 2 < argc) {
      org_kde_kwin_fake_input_pointer_motion_absolute(fake, wl_fixed_from_double(atof(argv[i+1])), wl_fixed_from_double(atof(argv[i+2])));
      i += 2;
    } else if (!strcmp(c, "click") || !strcmp(c, "down") || !strcmp(c, "up")) {
      uint32_t b = button(has_btn ? next : NULL); if (has_btn) i++;
      if (strcmp(c, "up")) { org_kde_kwin_fake_input_button(fake, b, WL_POINTER_BUTTON_STATE_PRESSED); wl_display_roundtrip(dpy); usleep(30000); }
      if (strcmp(c, "down")) org_kde_kwin_fake_input_button(fake, b, WL_POINTER_BUTTON_STATE_RELEASED);
    } else if (!strcmp(c, "key") && next) {
      int k = atoi(next); i++;
      org_kde_kwin_fake_input_keyboard_key(fake, k, WL_KEYBOARD_KEY_STATE_PRESSED); wl_display_roundtrip(dpy); usleep(20000);
      org_kde_kwin_fake_input_keyboard_key(fake, k, WL_KEYBOARD_KEY_STATE_RELEASED);
    } else if ((!strcmp(c, "keydown") || !strcmp(c, "keyup")) && next) {
      org_kde_kwin_fake_input_keyboard_key(fake, atoi(next), c[3] == 'd' ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED); i++;
    } else if (!strcmp(c, "wheel") && next) {
      org_kde_kwin_fake_input_axis(fake, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(atof(next))); i++;
    } else if (!strcmp(c, "sleep") && next) {
      wl_display_roundtrip(dpy); usleep(atoi(next) * 1000); i++;
    } else { fprintf(stderr, "bad command: %s\n", c); return 2; }
    wl_display_roundtrip(dpy);
  }
  wl_display_roundtrip(dpy);
  return 0;
}
