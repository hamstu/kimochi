import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@texthooker/lib/utils";

const buttonVariants = cva(
  "kimochi-button inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-(--color-bg-elev) text-(--color-text) hover:border-(--color-accent) hover:text-(--color-accent) border border-(--color-border)",
        ghost:
          "bg-transparent text-(--color-text-dim) hover:bg-(--color-bg-elev-2) hover:text-(--color-text)",
        active: "bg-(--color-accent-soft) text-(--color-accent)",
        danger:
          "bg-(--color-bg-elev) text-(--color-text) border border-(--color-border) hover:border-(--color-danger) hover:text-(--color-danger)",
        close:
          "bg-transparent text-(--color-text-dim) hover:bg-(--color-danger) hover:text-white",
      },
      size: {
        default: "h-7 px-2",
        icon: "h-7 w-7",
        sm: "h-6 px-2 text-xs",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
