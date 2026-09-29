import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True if the text contains any Japanese / CJK characters.
 * Covers Hiragana, Katakana (full + half-width), CJK Unified Ideographs,
 * Ext A, plus a few common punctuation glyphs that should still count
 * (々 iteration, 〆, ゝ).
 */
export function hasCJK(text: string): boolean {
  return /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ一-鿿㐀-䶿々〆]/.test(text);
}
