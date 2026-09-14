"use client";

import Link from "next/link";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import {
  Bell,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Users,
  Wrench,
} from "lucide-react";
import { signOut } from "@/actions/auth";
import { Logo } from "@/components/logo";
import type { UserProfile } from "@/lib/domain";
import { cn, initials } from "@/lib/utils";

const managerLinks = [
  { href: "/manager", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/manager/work-orders", label: "Work orders", icon: ClipboardList },
  { href: "/manager/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/manager/review", label: "Completion review", icon: CheckCircle2 },
  { href: "/manager/workers", label: "Workers", icon: Users },
  { href: "/manager/audit", label: "Audit history", icon: History },
  { href: "/manager/settings", label: "Settings", icon: Settings },
];

const workerLinks = [
  { href: "/worker", label: "Today", icon: Wrench, exact: true },
  { href: "/worker/upcoming", label: "Upcoming", icon: CalendarDays },
  { href: "/worker/history", label: "History", icon: CheckCircle2 },
  { href: "/worker/profile", label: "Profile", icon: Users },
];

function ActiveLink({
  item,
  compact = false,
}: {
  item: (typeof managerLinks)[number];
  compact?: boolean;
}) {
  const pathname = usePathname();
  const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition",
        active
          ? "bg-[#e2f1f8] text-[#003f70]"
          : "text-[#607181] hover:bg-[#eaf0f4] hover:text-[#173047]",
        compact && "flex-col gap-1 rounded-none px-1 py-2 text-[11px]",
      )}
    >
      <Icon className={cn("h-5 w-5", active && "text-[#0078ad]")} />
      <span>{item.label}</span>
    </Link>
  );
}

export function ManagerShell({
  profile,
  unread,
  children,
}: {
  profile: UserProfile;
  unread: number;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  return (
    <div className="min-h-screen bg-[#f3f6f9] lg:grid lg:grid-cols-[252px_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[252px] flex-col border-r border-[#d7e0e7] bg-[#f8fafc] p-4 lg:flex">
        <div className="px-2 py-3">
          <Logo href="/manager" priority />
        </div>
        <nav aria-label="Manager navigation" className="mt-7 flex-1 space-y-1">
          {managerLinks.map((item) => (
            <ActiveLink key={item.href} item={item} />
          ))}
        </nav>
        <div className="rounded-2xl border border-[#d7e0e7] bg-white p-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#003f70] text-sm font-bold text-white">
              {initials(profile.display_name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{profile.display_name}</p>
              <p className="truncate text-xs text-[#71808d]">Manager</p>
            </div>
            <form action={signOut}>
              <button
                aria-label="Sign out"
                className="grid h-10 w-10 place-items-center rounded-lg text-[#71808d] hover:bg-[#edf2f6] hover:text-[#913a31]"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[#d7e0e7] bg-[#f8fafc]/95 px-3 backdrop-blur lg:px-8">
          <div className="lg:hidden">
            <Logo href="/manager" priority />
          </div>
          <p className="hidden text-sm font-medium text-[#71808d] lg:block">
            REME Painting Group · Australia/Sydney
          </p>
          <div className="flex items-center gap-2">
            <details
              ref={menuRef}
              className="lg:hidden"
              onKeyDown={(event) => {
                if (event.key === "Escape" && menuRef.current) {
                  menuRef.current.open = false;
                  menuRef.current.querySelector("summary")?.focus();
                }
              }}
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-xl border border-[#d7e0e7] bg-white px-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                <Menu className="h-5 w-5" aria-hidden="true" /> Menu
              </summary>
              <nav
                aria-label="Mobile manager navigation"
                className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-[#d7e0e7] bg-[#f8fafc] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a") && menuRef.current)
                    menuRef.current.open = false;
                }}
              >
                <p className="mb-3 text-sm font-semibold break-words">
                  {profile.display_name} · Manager
                </p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {managerLinks.map((item) => (
                    <ActiveLink key={item.href} item={item} />
                  ))}
                  <ActiveLink
                    item={{ href: "/manager/notifications", label: "Notifications", icon: Bell }}
                  />
                </div>
                <form action={signOut} className="mt-3 border-t border-[#d7e0e7] pt-3">
                  <button className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-semibold text-[#913a31]">
                    <LogOut className="h-5 w-5" /> Sign out
                  </button>
                </form>
              </nav>
            </details>
            <Link
              aria-label={`${unread} unread notifications`}
              href="/manager/notifications"
              className="relative grid h-10 w-10 place-items-center rounded-xl border border-[#d7e0e7] bg-white text-[#40596d]"
            >
              <Bell className="h-5 w-5" />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-[#f58220] px-1 text-[10px] font-bold text-[#173047]">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Link>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] min-w-0 p-4 pb-10 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function WorkerShell({
  profile,
  unread,
  children,
}: {
  profile: UserProfile;
  unread: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#f3f6f9]">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-[#d7e0e7] bg-[#f8fafc]/95 px-4 backdrop-blur">
        <Logo href="/worker" priority />
        <div className="flex items-center gap-2">
          <Link
            href="/worker/notifications"
            aria-label={`${unread} unread notifications`}
            className="relative grid h-10 w-10 place-items-center rounded-xl text-[#40596d]"
          >
            <Bell className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute top-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#f8fafc] bg-[#f58220]" />
            )}
          </Link>
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#003f70] text-xs font-bold text-white">
            {initials(profile.display_name)}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-5 pb-28">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-[#d4dde5] bg-[#f8fafc]/98 pb-[max(.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(0,63,112,.08)] backdrop-blur">
        {workerLinks.map((item) => (
          <ActiveLink key={item.href} item={item} compact />
        ))}
      </nav>
    </div>
  );
}
