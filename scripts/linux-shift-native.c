// Diagnostic only: native Wayland Shift + pointer glide, no focus grab.
// Compile through linux-shift-native.sh; never linked into Kimochi.
#define _GNU_SOURCE
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "virtual-keyboard.h"
#include "virtual-pointer.h"

static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *km;
static struct zwlr_virtual_pointer_manager_v1 *pm;
static uint32_t stamp(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}
static void global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
    (void)data; (void)version;
    if (!strcmp(iface, "wl_seat")) seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
    if (!strcmp(iface, "zwp_virtual_keyboard_manager_v1"))
        km = wl_registry_bind(r, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    if (!strcmp(iface, "zwlr_virtual_pointer_manager_v1"))
        pm = wl_registry_bind(r, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}
static void gone(void *data, struct wl_registry *r, uint32_t name) { (void)data; (void)r; (void)name; }
static void move(struct wl_display *d, struct zwlr_virtual_pointer_v1 *p, int x, int y, int w, int h) {
    uint32_t t = stamp();
    printf("%u pointer %d,%d\n", t, x, y); fflush(stdout);
    zwlr_virtual_pointer_v1_motion_absolute(p, t, x, y, w, h);
    zwlr_virtual_pointer_v1_frame(p);
    wl_display_roundtrip(d);
}
int main(int argc, char **argv) {
    if (argc != 10) {
        fprintf(stderr, "Usage: %s KEY(42|54) X1 Y1 X2 Y2 X3 Y3 ROOT_LOGICAL_WIDTH HEIGHT\n", argv[0]);
        return 2;
    }
    int key = atoi(argv[1]), w = atoi(argv[8]), h = atoi(argv[9]);
    if ((key != 42 && key != 54) || w <= 0 || h <= 0) return 2;
    for (int j = 2; j <= 6; j += 2)
        if (atoi(argv[j]) < 0 || atoi(argv[j]) >= w || atoi(argv[j+1]) < 0 || atoi(argv[j+1]) >= h) return 2;
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { perror("wl_display_connect"); return 1; }
    struct wl_registry *r = wl_display_get_registry(d);
    const struct wl_registry_listener listener = {global, gone};
    wl_registry_add_listener(r, &listener, NULL); wl_display_roundtrip(d);
    if (!seat || !km || !pm) {
        fprintf(stderr, "Compositor lacks virtual keyboard/pointer protocols; diagnostic unavailable\n");
        return 1;
    }
    struct xkb_context *ctx = xkb_context_new(0);
    struct xkb_rule_names rules = {.layout = "us", .options = getenv("KIMOCHI_TEST_XKB_OPTIONS")};
    struct xkb_keymap *map = xkb_keymap_new_from_names(ctx, &rules, 0);
    if (!map) return 1;
    char *text = xkb_keymap_get_as_string(map, XKB_KEYMAP_FORMAT_TEXT_V1);
    int fd = memfd_create("kimochi-shift-diagnostic", 0);
    if (fd < 0 || write(fd, text, strlen(text)+1) != (ssize_t)(strlen(text)+1)) { perror("keymap"); return 1; }
    struct zwp_virtual_keyboard_v1 *k = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(km, seat);
    zwp_virtual_keyboard_v1_keymap(k, 1, fd, strlen(text)+1); wl_display_roundtrip(d); close(fd);
    struct zwlr_virtual_pointer_v1 *p = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pm, seat);
    move(d, p, atoi(argv[2]), atoi(argv[3]), w, h); usleep(500000);
    uint32_t t = stamp(); printf("%u Shift down\n", t); fflush(stdout);
    zwp_virtual_keyboard_v1_modifiers(k, 1, 0, 0, 0);
    zwp_virtual_keyboard_v1_key(k, t, key, 1); wl_display_roundtrip(d);
    usleep(1000000);
    for (int j = 4; j <= 6; j += 2) {
        move(d, p, atoi(argv[j]), atoi(argv[j+1]), w, h); usleep(1000000);
    }
    usleep(1000000);
    t = stamp(); printf("%u Shift up\n", t); fflush(stdout);
    zwp_virtual_keyboard_v1_modifiers(k, 0, 0, 0, 0);
    zwp_virtual_keyboard_v1_key(k, t, key, 0); wl_display_roundtrip(d);
    usleep(300000);
    zwp_virtual_keyboard_v1_destroy(k); zwlr_virtual_pointer_v1_destroy(p);
    wl_display_flush(d); wl_display_disconnect(d);
    free(text); xkb_keymap_unref(map); xkb_context_unref(ctx);
    return 0;
}
