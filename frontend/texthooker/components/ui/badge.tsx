import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@texthooker/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded px-1.5 py-[1px] text-[0.625rem] font-medium border",
  {
    variants: {
      variant: {
        default:
          "bg-(--color-bg-elev-2) text-(--color-text-dim) border-(--color-border)",
        accent:
          "bg-(--color-accent-soft) text-(--color-accent) border-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
