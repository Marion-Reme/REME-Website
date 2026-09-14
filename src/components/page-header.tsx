import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0 break-words">
        {eyebrow && (
          <p className="mb-1 text-xs font-bold tracking-[.16em] text-[#b44a00] uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="text-3xl font-semibold tracking-[-.035em] text-[#173047] sm:text-[2.1rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[15px] leading-6 text-[#607181]">{description}</p>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
