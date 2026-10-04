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
export interface OcrGroup {
  id: string;
  text: string;
  bbox: [number, number, number, number] | null;
  orientation: Orientation;
  confidence?: number;
  linePolygons?: number[][][];
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
  const supplied = Array.isArray(raw.groups) && raw.groups.length > 0;
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
    groups.push(...inferred.groups);
    annotations = inferred.annotations;
  } else if (raw.fullText?.trim())
    groups.push({
      id: "text-0",
      text: raw.fullText.trim(),
      bbox: null,
      orientation: "horizontal",
    });
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
