import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff } from "lucide-react";
import { Dialog, DialogContent, IconButton, Tooltip } from "@kit";
import { useSetting } from "../../bridge/useSetting";
import { lineDate } from "@texthooker/lib/logDays";
import {
  showShot,
  useOpenShot,
  useShots,
  type Shot,
} from "@texthooker/lib/screenshots";

/**
 * A scan's screenshot, near full window (opened from a Log line's thumbnail). ◀ ▶ (and the arrow
 * keys) step through every kept screenshot, oldest to newest. The eye shows or hides what OCR read:
 * the crop area, with the rest of the source faded, and a box round each text it found, which
 * says the text on hover. That choice is kept (`screenshotAnnotations`).
 */
export function ScreenshotViewer() {
  const scan = useOpenShot();
  const shots = useShots();
  const index = scan ? shots.findIndex((s) => s.scan === scan) : -1;
  const shot = index >= 0 ? shots[index] : undefined;
  const [annotations, setAnnotations] = useSetting<boolean>(
    "screenshotAnnotations",
    true,
  );
  const step = (by: number) => {
    const next = shots[index + by];
    if (next) showShot(next.scan);
  };

  useEffect(() => {
    if (!shot) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog open={Boolean(shot)} onOpenChange={(open) => !open && showShot(null)}>
      {shot ? (
        <DialogContent
          className="shot-viewer"
          title={lineDate(shot.at)}
          description={`${index + 1} of ${shots.length}`}
          actions={
            <Tooltip content={annotations ? "Hide what OCR read" : "Show what OCR read"}>
              <IconButton
                label={annotations ? "Hide what OCR read" : "Show what OCR read"}
                size="sm"
                aria-pressed={annotations}
                onClick={() => void setAnnotations(!annotations)}
              >
                {annotations ? <Eye /> : <EyeOff />}
              </IconButton>
            </Tooltip>
          }
        >
          <div className="shot-viewer-stage">
            <IconButton
              label="Previous screenshot"
              className="shot-viewer-step"
              disabled={index <= 0}
              onClick={() => step(-1)}
            >
              <ChevronLeft />
            </IconButton>
            <div className="shot-viewer-frame">
              <ShotPicture key={shot.scan} shot={shot} annotations={annotations} />
            </div>
            <IconButton
              label="Next screenshot"
              className="shot-viewer-step"
              disabled={index >= shots.length - 1}
              onClick={() => step(1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/** The picture at its own aspect ratio, as large as fits, with what OCR read over it. */
function ShotPicture({ shot, annotations }: { shot: Shot; annotations: boolean }) {
  const [failed, setFailed] = useState(false);
  const { width: w, height: h } = shot;
  return (
    <div
      className="shot-viewer-picture"
      style={{ ["--shot-ratio" as string]: w / h }}
      data-annotations={annotations || undefined}
    >
      {failed ? (
        <p className="shot-viewer-gone">This screenshot is no longer kept.</p>
      ) : (
        <img src={shot.url} alt="" draggable={false} onError={() => setFailed(true)} />
      )}
      {annotations && !failed ? (
        <>
          {shot.crop ? (
            <span
              className="shot-viewer-crop"
              aria-hidden
              style={{
                left: pct(shot.crop[0], w),
                top: pct(shot.crop[1], h),
                width: pct(shot.crop[2], w),
                height: pct(shot.crop[3], h),
              }}
            />
          ) : null}
          {shot.marks.map((mark, i) => (
            <Tooltip key={i} content={<span lang="ja">{mark.text}</span>} delayDuration={0}>
              <span
                className="shot-viewer-mark"
                style={{
                  left: pct(mark.bbox[0], w),
                  top: pct(mark.bbox[1], h),
                  width: pct(mark.bbox[2] - mark.bbox[0], w),
                  height: pct(mark.bbox[3] - mark.bbox[1], h),
                }}
              />
            </Tooltip>
          ))}
        </>
      ) : null}
    </div>
  );
}
