/** Shared OCR result contract. Engines supply semantic blocks when available;
 * fragmented engines are grouped by geometry here, before rendering or publication.
 * All coordinates remain in capture pixels. No display/backing scale enters this module.
 */
import {
  getBoundingBox,
  wordAnnotations,
  type Annotation,
} from "./annotations.js";
export type Orientation = "horizontal" | "vertical";
/** A piece of a line (a word, or a character) with its own box, in capture pixels. */
export interface Segment {
  text: string;
  bbox: [number, number, number, number];
}
export interface OcrGroup {
  id: string;
  text: string;
  bbox: [number, number, number, number] | null;
  orientation: Orientation;
  confidence?: number;
  linePolygons?: number[][][];
  /** Per line of `linePolygons`, the words found on it with their boxes, when the engine gives them. */
  lineSegments?: Segment[][];
  /**
   * Per line of `linePolygons`, its text, when the engine read each line on its own (Manga OCR,
   * as mokuro does). The overlay sets each line's text on its line as it is.
   */
  lines?: string[];
  /**
   * Grouped here from the engine's words (`logicalGroups`), not supplied by the engine. A result
   * normalised again (a reloaded overlay redrawing the saved scan) groups its words afresh rather
   * than drawing these as the engine's blocks, which would merge every word of a group into one box.
   */
  inferred?: true;
}

/**
 * How far outside the ink each engine draws its boxes, in ems of the glyph size: along the line
 * at its start and its end, and across it before and after (above and below a horizontal line,
 * right and left of a vertical column). The overlay fits its own text's ink inside these margins
 * (text-layout.js), so a box that runs past the ink, as Live Text's does below a line, sizes and
 * places nothing wrong. Measured on the overlay alignment corpus
 * (scripts/measure-overlay-alignment.mjs, medians, rounded); an engine not listed gets the
 * overlay's default of 0.05 all round.
 */
export const INK_MARGINS: Record<string, [number, number, number, number]> = {
  cloud: [0.05, 0.02, 0.05, 0.05],
  googlelens: [0.06, 0, 0.06, 0.03],
  livetext: [0.1, 0.18, 0.04, 0.15],
  meikiocr: [0.12, 0, 0.05, 0],
  mangaocr: [0.1, 0.15, 0.15, 0.15],
};

/**
 * The typeface the overlay sets an engine's text in, where it is not the overlay's own: Manga OCR
 * reads manga, and its text is drawn in a manga face (MANGA_FONT in render.js).
 */
export const TYPEFACES: Record<string, string> = {
  mangaocr: "manga",
};

/** Annotations stamped with their engine's ink margins and typeface, where it has them. */
export function withInkMargins(
  annotations: Annotation[],
  engine: string,
): Annotation[] {
  const margin = INK_MARGINS[engine];
  const typeface = TYPEFACES[engine];
  if (!margin && !typeface) return annotations;
  return annotations.map((a) => ({
    ...a,
    ...(margin ? { inkMargin: margin } : {}),
    ...(typeface ? { typeface } : {}),
  }));
}

const box = (
  b: { minX: number; minY: number; maxX: number; maxY: number },
): [number, number, number, number] => [b.minX, b.minY, b.maxX, b.maxY];

/** Segments in reading order: down a column, along a line. */
const ordered = (segments: Segment[], vertical: boolean): Segment[] =>
  [...segments].sort((a, b) =>
    vertical ? a.bbox[1] - b.bbox[1] : a.bbox[0] - b.bbox[0],
  );

/**
 * Where an engine puts the words of a line, as segments: OneOCR returns its lines as groups and
 * their words as fragments with the group's id; each fragment goes to the line it lies in.
 */
function fragmentSegments(
  group: OcrGroup,
  fragments: Annotation[],
): Segment[][] | undefined {
  const lines = group.linePolygons ?? [];
  const words = fragments.filter((a) => a.groupId === group.id);
  if (!lines.length || !words.length) return undefined;
  const bounds = lines.map((polygon) => [
    Math.min(...polygon.map((p) => p[0])),
    Math.min(...polygon.map((p) => p[1])),
    Math.max(...polygon.map((p) => p[0])),
    Math.max(...polygon.map((p) => p[1])),
  ]);
  const segments: Segment[][] = lines.map(() => []);
  for (const word of words) {
    const b = getBoundingBox(word);
    const line = bounds.findIndex(
      ([x1, y1, x2, y2]) =>
        b.centerX >= x1 && b.centerX <= x2 && b.centerY >= y1 && b.centerY <= y2,
    );
    if (line >= 0) segments[line].push({ text: word.description, bbox: box(b) });
  }
  return segments.map((line) => ordered(line, group.orientation === "vertical"));
}

const isSegment = (s: unknown): s is Segment =>
  typeof (s as Segment)?.text === "string" &&
  Array.isArray((s as Segment).bbox) &&
  (s as Segment).bbox.length === 4 &&
  (s as Segment).bbox.every(Number.isFinite);

/**
 * A block's `lineSegments`: the engine's own (Google Lens), else its word fragments placed on its
 * lines (OneOCR), one list per line polygon; nothing when neither is there or they do not fit.
 */
function lineSegmentsOf(
  group: OcrGroup,
  fragments: Annotation[],
): { lineSegments?: Segment[][] } {
  const lines = group.linePolygons?.length ?? 0;
  const own = group.lineSegments;
  const segments =
    Array.isArray(own) && own.length === lines
      ? own.map((line) => (Array.isArray(line) ? line.filter(isSegment) : []))
      : fragmentSegments(
          group,
          fragments.filter((a) => a.granularity === "fragment"),
        );
  return lines && segments?.some((line) => line.length) ? { lineSegments: segments } : {};
}

/** A block's `lines`, as `lineTexts`, when there is one string for each of its line polygons. */
function lineTextsOf(group: OcrGroup): { lineTexts?: string[] } {
  const lines = group.lines;
  return Array.isArray(lines) &&
    lines.length > 0 &&
    lines.length === group.linePolygons?.length &&
    lines.every((line) => typeof line === "string")
    ? { lineTexts: lines }
    : {};
}

/** MeikiOCR's per-character boxes, as segments of its line. */
function characterSegments(a: Annotation): Segment[] | undefined {
  const characters = (a as { characters?: { character?: unknown; bbox?: unknown }[] })
    .characters;
  if (!Array.isArray(characters) || !characters.length) return undefined;
  const segments = characters.flatMap((c) =>
    typeof c?.character === "string" &&
    Array.isArray(c.bbox) &&
    c.bbox.length === 4 &&
    c.bbox.every(Number.isFinite)
      ? [{ text: c.character, bbox: c.bbox as [number, number, number, number] }]
      : [],
  );
  return segments.length === characters.length ? segments : undefined;
}
export interface OcrResult {
  schemaVersion: 1;
  engine: string;
  fullText: string;
  textAnnotations: Annotation[];
  groups: OcrGroup[];
  geometry: boolean;
}
function explicit(a: Annotation): Orientation | null {
  if (a.orientation === "vertical" || a.orientation === "horizontal")
    return a.orientation;
  if (typeof a.isVertical === "boolean")
    return a.isVertical ? "vertical" : "horizontal";
  return null;
}
/** Honor model metadata first. Tall multi-character runs are strong evidence;
 * square glyphs require aligned neighbors, so one punctuation mark cannot flip a page.
 */
export function inferOrientations(annotations: Annotation[]): Annotation[] {
  const boxed = annotations.map((a) => ({ a, b: getBoundingBox(a) }));
  return boxed.map(({ a, b }) => {
    let orientation = explicit(a);
    if (!orientation && [...a.description].length > 1) {
      if (b.height > b.width * 1.5) orientation = "vertical";
      else if (b.width > b.height * 1.5) orientation = "horizontal";
    }
    if (!orientation) {
      let vertical = 0,
        horizontal = 0;
      for (const other of boxed) {
        if (other.a === a) continue;
        const c = other.b;
        const dx = Math.abs(c.centerX - b.centerX),
          dy = Math.abs(c.centerY - b.centerY);
        if (
          explicit(other.a) !== "horizontal" &&
          dx < Math.min(c.width, b.width) * 0.65 &&
          dy > 0 &&
          dy < Math.max(c.height, b.height) * 2.5
        )
          vertical++;
        if (
          explicit(other.a) !== "vertical" &&
          dy < Math.min(c.height, b.height) * 0.65 &&
          dx > 0 &&
          dx < Math.max(c.width, b.width) * 2.5
        )
          horizontal++;
      }
      orientation = vertical > horizontal ? "vertical" : "horizontal";
    }
    return { ...a, orientation, isVertical: orientation === "vertical" };
  });
}
/** Paragraph grouping uses glyph-relative distances, not a page-wide fixed radius.
 * Explicit group IDs are authoritative and never merge with a different group.
 */
export function logicalGroups(input: Annotation[]): {
  groups: OcrGroup[];
  annotations: Annotation[];
} {
  const annotations = inferOrientations(input);
  const boxes = annotations.map(getBoundingBox);
  const parent = annotations.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < annotations.length; i++)
    for (let j = i + 1; j < annotations.length; j++) {
      const a = annotations[i],
        b = annotations[j];
      if (a.groupId || b.groupId) {
        if (a.groupId && a.groupId === b.groupId) parent[root(j)] = root(i);
        continue;
      }
      if (a.orientation !== b.orientation) continue;
      const x = boxes[i],
        y = boxes[j],
        vertical = a.orientation === "vertical";
      const em = Math.max(
        1,
        Math.min(vertical ? x.width : x.height, vertical ? y.width : y.height),
      );
      const alongGap = vertical
        ? Math.max(0, Math.max(x.minY, y.minY) - Math.min(x.maxY, y.maxY))
        : Math.max(0, Math.max(x.minX, y.minX) - Math.min(x.maxX, y.maxX));
      const crossGap = vertical
        ? Math.max(0, Math.max(x.minX, y.minX) - Math.min(x.maxX, y.maxX))
        : Math.max(0, Math.max(x.minY, y.minY) - Math.min(x.maxY, y.maxY));
      const aligned = vertical
        ? Math.abs(x.centerX - y.centerX) < em * 0.7
        : Math.abs(x.centerY - y.centerY) < em * 0.7;
      const parallelOverlap = vertical
        ? Math.min(x.maxY, y.maxY) - Math.max(x.minY, y.minY)
        : Math.min(x.maxX, y.maxX) - Math.max(x.minX, y.minX);
      if (
        (aligned && alongGap < em * 1.8) ||
        (parallelOverlap > em * 0.5 && crossGap < em * 0.8)
      )
        parent[root(j)] = root(i);
    }
  const members = new Map<number, number[]>();
  annotations.forEach((_, i) =>
    members.set(root(i), [...(members.get(root(i)) ?? []), i]),
  );
  const groups = [...members.values()].map((indices, index): OcrGroup => {
    const vertical = annotations[indices[0]].orientation === "vertical";
    indices.sort((i, j) => {
      const a = boxes[i],
        b = boxes[j];
      if (vertical)
        return Math.abs(a.centerX - b.centerX) <
          Math.min(a.width, b.width) * 0.7
          ? a.minY - b.minY
          : b.centerX - a.centerX;
      return Math.abs(a.centerY - b.centerY) <
        Math.min(a.height, b.height) * 0.7
        ? a.minX - b.minX
        : a.minY - b.minY;
    });
    const id = annotations[indices[0]].groupId ?? `group-${index}`;
    let text = "";
    let previous: (typeof boxes)[number] | null = null;
    for (const i of indices) {
      const b = boxes[i];
      if (previous) {
        const newLine = vertical
          ? Math.abs(previous.centerX - b.centerX) >
            Math.min(previous.width, b.width) * 0.7
          : Math.abs(previous.centerY - b.centerY) >
            Math.min(previous.height, b.height) * 0.7;
        if (newLine) text += "\n";
        else if (
          !vertical &&
          b.minX - previous.maxX > Math.min(previous.height, b.height) * 1.5
        )
          text += "　";
      }
      text += annotations[i].description;
      annotations[i] = { ...annotations[i], groupId: id };
      previous = b;
    }
    const selected = indices.map((i) => boxes[i]);
    return {
      id,
      text,
      orientation: vertical ? "vertical" : "horizontal",
      bbox: [
        Math.min(...selected.map((b) => b.minX)),
        Math.min(...selected.map((b) => b.minY)),
        Math.max(...selected.map((b) => b.maxX)),
        Math.max(...selected.map((b) => b.maxY)),
      ],
    };
  });
  return { groups, annotations };
}
export function normalizeOcrResult(
  raw: Partial<OcrResult>,
  engine: string,
): OcrResult {
  const supplied =
    Array.isArray(raw.groups) && raw.groups.some((g) => g && !g.inferred);
  const ids = new Set<string>();
  const groups: OcrGroup[] = supplied
    ? raw
        .groups!.filter((g) => g && typeof g.text === "string" && g.text.trim())
        .map((g, i) => {
          const validBox =
            Array.isArray(g.bbox) &&
            g.bbox.length === 4 &&
            g.bbox.every(Number.isFinite) &&
            g.bbox[0] < g.bbox[2] &&
            g.bbox[1] < g.bbox[3];
          const bbox = validBox ? g.bbox : null;
          let id = g.id || `group-${i}`;
          while (ids.has(id)) id = `${id}-${i}`;
          ids.add(id);
          const orientation =
            g.orientation === "vertical" || g.orientation === "horizontal"
              ? g.orientation
              : bbox && bbox[3] - bbox[1] > (bbox[2] - bbox[0]) * 1.5
                ? "vertical"
                : "horizontal";
          return { ...g, id, bbox, orientation };
        })
    : [];
  const incoming = raw.textAnnotations ?? [];
  const fragments = incoming.some((a) => a.granularity)
    ? incoming.filter((a) => a.granularity !== "aggregate")
    : wordAnnotations(incoming);
  let annotations = fragments
    .filter(
      (a) =>
        a.description?.trim() &&
        a.boundingPoly?.vertices?.length &&
        a.boundingPoly.vertices.every(
          (v) => Number.isFinite(v.x ?? 0) && Number.isFinite(v.y ?? 0),
        ),
    )
    .filter((a) => {
      const b = getBoundingBox(a);
      return b.width > 0 && b.height > 0;
    });
  if (supplied) {
    annotations = groups
      .filter((g) => g.bbox)
      .map((g) => ({
        description: g.text,
        groupId: g.id,
        granularity: "block",
        orientation: g.orientation,
        isVertical: g.orientation === "vertical",
        // Where the engine found each line inside the block; grouped text is laid out on them.
        ...(Array.isArray(g.linePolygons) && g.linePolygons.length
          ? { linePolygons: g.linePolygons }
          : {}),
        // And the words on each line, which place the text past a gap OCR left out (a space).
        ...lineSegmentsOf(g, fragments),
        // And each line's own text, where the engine read the lines one by one.
        ...lineTextsOf(g),
        boundingPoly: {
          vertices: [
            { x: g.bbox![0], y: g.bbox![1] },
            { x: g.bbox![2], y: g.bbox![1] },
            { x: g.bbox![2], y: g.bbox![3] },
            { x: g.bbox![0], y: g.bbox![3] },
          ],
        },
      }));
  } else if (annotations.length) {
    const inferred = logicalGroups(annotations);
    groups.push(
      ...inferred.groups.map((g) => ({ ...g, inferred: true as const })),
    );
    annotations = inferred.annotations.map((a) => {
      const segments = characterSegments(a);
      return segments ? { ...a, segments } : a;
    });
  } else if (raw.fullText?.trim())
    groups.push({
      id: "text-0",
      text: raw.fullText.trim(),
      bbox: null,
      orientation: "horizontal",
    });
  annotations = withInkMargins(annotations, raw.engine || engine);
  const fullText = groups.map((g) => g.text).join("\n") || raw.fullText || "";
  // Preserve the existing aggregate-at-zero contract for downstream code.
  const aggregate = annotations.length
    ? {
        description: fullText,
        boundingPoly: annotations[0].boundingPoly,
        granularity: "aggregate" as const,
      }
    : null;
  return {
    schemaVersion: 1,
    engine: raw.engine || engine,
    groups,
    fullText,
    textAnnotations: aggregate ? [aggregate, ...annotations] : [],
    geometry: raw.geometry !== false && annotations.length > 0,
  };
}
