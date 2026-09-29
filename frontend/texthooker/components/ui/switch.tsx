import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@texthooker/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn("kimochi-switch", className)}
    {...props}
  >
    <SwitchPrimitive.Thumb className={cn("kimochi-switch-thumb")} />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
