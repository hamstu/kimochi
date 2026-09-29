/** Adapter: the Texthooker badge API over the Kimochi kit Badge. New code imports `@kit`. */
import * as React from "react";
import { Badge as KitBadge } from "@kit/Feedback";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "accent" | null;
}

export function Badge({ variant, ...props }: BadgeProps) {
  return (
    <KitBadge tone={variant === "accent" ? "accent" : "neutral"} {...props} />
  );
}
