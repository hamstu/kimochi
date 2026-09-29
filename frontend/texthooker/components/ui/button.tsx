/** Adapter: the Texthooker's button API over the Kimochi kit Button. New code imports `@kit`. */
import * as React from "react";
import { Button as KitButton, type ButtonVariant } from "@kit/Button";

type LegacyVariant = "default" | "ghost" | "active" | "danger" | "close";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: LegacyVariant | null;
  size?: "default" | "icon" | "sm" | null;
}

const VARIANTS: Record<LegacyVariant, ButtonVariant> = {
  default: "secondary",
  ghost: "ghost",
  active: "ghost",
  danger: "danger",
  close: "ghost",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, size, ...props }, ref) => (
    <KitButton
      ref={ref}
      variant={VARIANTS[variant ?? "ghost"]}
      size={size === "sm" ? "sm" : "md"}
      icon={size === "icon"}
      data-active={variant === "active" ? "" : undefined}
      {...props}
    />
  ),
);
Button.displayName = "Button";
