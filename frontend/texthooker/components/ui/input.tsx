import * as React from "react";
import { cn } from "@texthooker/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn("kimochi-input", className)} {...props} />
  ),
);
Input.displayName = "Input";
