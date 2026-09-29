/** Adapter: re-exports the Kimochi kit Input. New code imports `@kit`. */
import * as React from "react";
import { Input as KitInput } from "@kit/TextField";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (props, ref) => <KitInput ref={ref} {...(props as object)} />,
);
Input.displayName = "Input";
