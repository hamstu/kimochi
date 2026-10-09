/** Conservative loose matching: normalize case/spacing, retain game/title distinctions. */
export interface SourceName {
  type?: string;
  name?: string;
  appName?: string;
  sourceId?: string;
  applicationContext?: { id: string; name: string };
}
export const normalizedName = (text: string): string =>
  text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
export function sourceKey(source?: SourceName | null): string | null {
  if (source?.applicationContext?.id)
    return `application:${source.applicationContext.id}`;
  if (!source || source.type !== "window") return null;
  return normalizedName(source.name || source.appName || "") || null;
}
export function matchedSession(
  source: SourceName,
  sessions: { id: string; name: string }[],
  bindings: Record<string, string>,
): string | null {
  const key = sourceKey(source);
  if (!key) return null;
  const bound = bindings[key];
  if (bound && sessions.some((s) => s.id === bound)) return bound;
  // Game IDs are authoritative; never merge two different games by display name.
  if (source.applicationContext) return null;
  const exact = sessions.filter((s) => normalizedName(s.name) === key);
  if (exact.length === 1) return exact[0].id;
  // Only use the app name when it uniquely identifies a session; never guess among games.
  const app = normalizedName(source.appName || "");
  const matches = app
    ? sessions.filter((s) => normalizedName(s.name) === app)
    : [];
  return matches.length === 1 ? matches[0].id : null;
}
