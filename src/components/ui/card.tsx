import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border border-[#d7e0e7] bg-white shadow-[0_1px_2px_rgba(0,63,112,0.04)]",
        className,
      )}
      {...props}
    />
  );
}
