# Integrated capture-core copy

Derived from `../../tauri-screen-capture/capture-core` without modifying that completed experiment.

The capture API, crop validation, frame mapping and pixel conversion are unchanged. The macOS display filter now excludes windows owned by Kimochi's current process, refreshed with each source catalog lookup. This is intended to keep the overlay and native controls out of display scans without hiding them. Independent window capture is unchanged. The permission error names this app.

Static build/tests are recorded in the migration report. Runtime exclusion and capture feedback need user testing; the original spike's evidence does not prove this filter change.
