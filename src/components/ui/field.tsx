import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-[#35423f]">
      {children}
      {hint && <span className="ml-1 font-normal text-[#7c8582]">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-11 w-full min-w-0 rounded-xl border border-[#d9d4c9] bg-white px-3.5 text-base text-[#24312f] outline-none placeholder:text-[#9aa19e] focus:border-[#007ba7] focus:ring-3 focus:ring-[#d9eef6] sm:text-[15px]",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "min-h-11 w-full min-w-0 rounded-xl border border-[#d9d4c9] bg-white px-3.5 text-base text-[#24312f] outline-none focus:border-[#007ba7] focus:ring-3 focus:ring-[#d9eef6] sm:text-[15px]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-28 w-full resize-y rounded-xl border border-[#d9d4c9] bg-white px-3.5 py-3 text-base text-[#24312f] outline-none placeholder:text-[#9aa19e] focus:border-[#007ba7] focus:ring-3 focus:ring-[#d9eef6] sm:text-[15px]",
        className,
      )}
      {...props}
    />
  );
}
