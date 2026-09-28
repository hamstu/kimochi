//! Apple Live Text against real Japanese glyphs, driven the way the app drives it.
//!
//! `harness = false` because this has to own the process's main thread. Live Text
//! delivers its completion to the main run loop, so the observation runs on a
//! worker — as it does in the app, on a capture worker — while this thread pumps
//! the run loop an application is always running anyway. Under the default test
//! harness the main thread is the harness's, nothing pumps, and every observation
//! would time out no matter how correct the code was.
//!
//! Everything here is offline: the fixtures are rendered with the system's own
//! fonts, nothing is downloaded, no screen is captured and no service is called.

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("ok 0 - Apple Live Text is macOS only; nothing to run here");
}

#[cfg(target_os = "macos")]
fn main() {
    use kimochi_capture::text::fixture::{japanese_frame, Placement};
    use kimochi_capture::text::AckProbe;
    use kimochi_capture::{dhash_rgba, platform_observer, Frame, Observation};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    type CFStringRef = *const std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: CFStringRef;
        fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_handled: u8) -> i32;
    }

    /// Run `work` on a worker while this thread services the main run loop.
    fn on_worker<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, wait: Duration) -> T {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(work());
        });
        let deadline = Instant::now() + wait;
        loop {
            if let Ok(value) = rx.try_recv() {
                return value;
            }
            assert!(Instant::now() < deadline, "the worker never answered");
            // SAFETY: servicing this thread's run loop, as an application does.
            unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, 1) };
        }
    }

    fn observe(frame: Frame) -> Observation {
        on_worker(
            move || {
                let mut observer = platform_observer();
                observer.observe(&frame, Duration::from_secs(10))
            },
            Duration::from_secs(20),
        )
        .expect("an observation")
    }

    fn place(x: f64, top: f64, size: f64) -> Placement {
        Placement { x, top, size }
    }

    /// Drop the characters a recogniser is entitled to disagree about, so the
    /// assertions are about words rather than about punctuation.
    fn squash(text: &str) -> String {
        text.chars()
            .filter(|c| !c.is_whitespace() && !matches!(c, '。' | '、' | '「' | '」' | '・'))
            .collect()
    }

    let mut failures: Vec<String> = Vec::new();
    let mut ran = 0usize;
    let mut case = |name: &str, body: &dyn Fn()| {
        ran += 1;
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
            Ok(()) => println!("ok {ran} - {name}"),
            Err(payload) => {
                let why = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panicked".into());
                println!("not ok {ran} - {name}\n  {why}");
                failures.push(name.to_string());
            }
        }
    };

    let supported = platform_observer().status().supported
        || {
            let mut observer = platform_observer();
            let _ = observer.observe(&japanese_frame(64, 32, &[]), Duration::from_millis(50));
            observer.status().supported
        };
    if !supported {
        println!("ok 0 - Apple Live Text is unavailable on this host; skipping");
        return;
    }

    case("it reads Japanese off a rendered fixture", &|| {
        let observation = observe(japanese_frame(
            900,
            220,
            &[
                ("猫が好きです", place(40.0, 40.0, 48.0)),
                ("今日は寒いですね", place(40.0, 120.0, 48.0)),
            ],
        ));
        let read = squash(&observation.text);
        assert!(read.contains("猫が好きです"), "read {read:?}");
        assert!(read.contains("今日は寒いですね"), "read {read:?}");
        assert!(observation.lines.len() >= 2, "{} lines", observation.lines.len());
        assert_eq!(observation.engine, "apple-live-text");
        assert!(
            observation.duration_ms < 3000.0,
            "took {}ms, too slow to run every half second",
            observation.duration_ms
        );
        println!("  # read {read:?} in {:.0}ms", observation.duration_ms);
    });

    case("a one-character change reads as different text", &|| {
        // The case the whole settling policy is built around: two sentences that
        // a similarity threshold would call the same must not come back equal.
        let first = squash(&observe(japanese_frame(700, 140, &[("今日は寒いね", place(40.0, 30.0, 48.0))])).text);
        let second = squash(&observe(japanese_frame(700, 140, &[("今日は寒いよ", place(40.0, 30.0, 48.0))])).text);
        assert!(first.contains("今日は寒い"), "read {first:?}");
        assert!(second.contains("今日は寒い"), "read {second:?}");
        assert_ne!(first, second, "the observer distinguished ね from よ");
    });

    case("a new sentence in the same place is read as new text", &|| {
        // Identical geometry, different words. A pipeline that deduplicated on
        // box position alone would lose the second line entirely.
        let at = place(60.0, 200.0, 44.0);
        let before = observe(japanese_frame(800, 400, &[("最初の台詞です", at)]));
        let after = observe(japanese_frame(800, 400, &[("次の台詞になった", at)]));
        assert!(squash(&before.text).contains("最初の台詞"), "{:?}", before.text);
        assert!(squash(&after.text).contains("次の台詞"), "{:?}", after.text);
        assert_ne!(squash(&before.text), squash(&after.text));

        let (a, b) = (&before.lines[0], &after.lines[0]);
        let moved = (a.y - b.y).abs();
        assert!(moved < 20.0, "the boxes really are in the same place ({moved}px)");
    });

    case("line geometry lands in frame pixels with a top-left origin", &|| {
        // Not documented anywhere, so it is measured rather than assumed: one
        // line near the top and one near the bottom of a tall image.
        let observation = observe(japanese_frame(
            800,
            600,
            &[
                ("上の行です", place(40.0, 30.0, 44.0)),
                ("下の行です", place(40.0, 500.0, 44.0)),
            ],
        ));
        let find = |needle: &str| {
            observation
                .lines
                .iter()
                .find(|line| squash(&line.text).contains(needle))
                .unwrap_or_else(|| panic!("{needle} in {:?}", observation.text))
        };
        let top = find("上の行");
        let bottom = find("下の行");
        for line in [top, bottom] {
            // Frame pixels, not fractions: the adapter converts before returning.
            assert!(
                (0.0..=800.0).contains(&line.x) && (0.0..=600.0).contains(&line.y),
                "inside the frame, in its own pixels: {line:?}"
            );
            assert!(line.width > 1.0 && line.height > 1.0, "{line:?}");
        }
        assert!(
            top.y < bottom.y,
            "top-left origin: the upper line has the smaller y ({} vs {})",
            top.y,
            bottom.y
        );
        assert!(top.y < 200.0, "the upper line really is near the top: {}", top.y);
        assert!(bottom.y > 400.0, "and the lower one near the bottom: {}", bottom.y);
        println!("  # top y={:.1}px bottom y={:.1}px (frame is 600px tall)", top.y, bottom.y);
    });

    case("a cropped frame is observed in its own pixels", &|| {
        // The observer is handed the frame the capture already cropped, so its
        // coordinates are relative to the crop and not to the whole source.
        let observation = observe(japanese_frame(400, 120, &[("切り抜き", place(20.0, 20.0, 44.0))]));
        assert!(squash(&observation.text).contains("切り抜き"), "{:?}", observation.text);
        let line = &observation.lines[0];
        assert!(
            line.x < 200.0 && line.y < 60.0,
            "near the crop's own origin, not the source's: {line:?}"
        );
        assert!(line.width > 40.0, "and a real part of its 400px width: {line:?}");
    });

    case("a blank frame reads as no text rather than as an error", &|| {
        let observation = observe(japanese_frame(400, 200, &[]));
        assert_eq!(observation.text, "");
        assert!(observation.lines.is_empty());
    });

    case("repeated observations stay correct and retain one analysis at a time", &|| {
        // Automatic scanning calls this several times a second, for hours.
        let elapsed = on_worker(
            move || {
                let mut observer = platform_observer();
                let frame = japanese_frame(600, 160, &[("繰り返し", place(40.0, 40.0, 44.0))]);
                let started = Instant::now();
                for round in 0..12 {
                    let observation = observer
                        .observe(&frame, Duration::from_secs(10))
                        .unwrap_or_else(|e| panic!("round {round}: {}", e.message));
                    assert!(
                        squash(&observation.text).contains("繰り返し"),
                        "round {round}: {:?}",
                        observation.text
                    );
                }
                started.elapsed()
            },
            Duration::from_secs(60),
        );
        println!("  # 12 observations in {elapsed:?}");
    });

    case("an acknowledgement cannot arrive while its own main-queue item runs", &|| {
        // The ordering the whole reclamation rule rests on. This thread *is* the
        // main queue's current item, so a block submitted to that serial queue
        // cannot run until this returns. Spinning here as long as we like must
        // not make it true.
        let probe = AckProbe::submit();
        assert!(!probe.off_main(), "this is the main thread");
        assert!(
            !probe.acknowledged(),
            "acknowledged before the submitting item finished"
        );

        let spun = Instant::now();
        while spun.elapsed() < Duration::from_millis(150) {
            assert!(
                !probe.acknowledged(),
                "the queue ran the acknowledgement while its submitter was still on the stack"
            );
            std::hint::spin_loop();
        }

        // Only once the queue is actually driven does it become true.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !probe.acknowledged() {
            assert!(Instant::now() < deadline, "the acknowledgement never ran");
            // SAFETY: servicing this thread's run loop, as an application does.
            unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, 1) };
        }
        println!("  # acknowledged only after the run loop was driven");
    });

    case("reclamation is ordered across many real observations", &|| {
        // Each observation may only start once the previous one has been
        // acknowledged on the main queue, so twelve in a row passing is twelve
        // acknowledgements that actually ran.
        let elapsed = on_worker(
            move || {
                let mut observer = platform_observer();
                let frame = japanese_frame(600, 160, &[("順番", place(40.0, 40.0, 44.0))]);
                let started = Instant::now();
                for round in 0..12 {
                    let observation = observer
                        .observe(&frame, Duration::from_secs(10))
                        .unwrap_or_else(|e| panic!("round {round}: {} {}", e.code, e.message));
                    assert!(
                        squash(&observation.text).contains("順番"),
                        "round {round}: {:?}",
                        observation.text
                    );
                }
                started.elapsed()
            },
            Duration::from_secs(60),
        );
        println!("  # 12 acknowledged observations in {elapsed:?}");
    });

    case("the native hash describes the same frame the observer read", &|| {
        // Both come off one buffer, so neither can describe a frame the other
        // never saw — which is what the fetch-the-PNG-back round trip allowed.
        let a = japanese_frame(400, 120, &[("あいうえお", place(20.0, 20.0, 40.0))]);
        let b = japanese_frame(400, 120, &[("かきくけこ", place(20.0, 20.0, 40.0))]);
        let ha = dhash_rgba(&a.pixels, a.info.width, a.info.height).expect("a hash");
        let hb = dhash_rgba(&b.pixels, b.info.width, b.info.height).expect("a hash");
        assert_eq!(ha.len(), 16);
        assert_ne!(ha, hb, "different text, different picture");
        assert_eq!(
            ha,
            dhash_rgba(&a.pixels, a.info.width, a.info.height).unwrap(),
            "and the same frame always hashes the same"
        );
    });

    println!("1..{ran}");
    if !failures.is_empty() {
        eprintln!("\nFAILED: {}", failures.join(", "));
        std::process::exit(1);
    }
    println!("# all {ran} Apple Live Text fixture cases passed");
}
