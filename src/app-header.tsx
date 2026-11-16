import { avatarSrc } from "@open-workspace/core/shared";
import {
  AppearanceMenuRow,
  AppSwitcher,
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  initials,
  useAuth,
  useWorkspaceBrand,
  WorkspaceLogo,
} from "@open-workspace/core/ui";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { DRIVE_MODULE } from "../shared/module";

/** The workspace's logo and name, then the app switcher, as every app's header starts. */
function ProductMark() {
  const brand = useWorkspaceBrand();

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <WorkspaceLogo src={brand.logoUrl} flat />
      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-none tracking-[-0.015em]">
        <span className="hidden truncate font-semibold sm:inline">
          {brand.name}
        </span>
        <span className="bg-border hidden h-3.5 w-px shrink-0 sm:block" />
        <AppSwitcher current={DRIVE_MODULE} />
      </span>
    </span>
  );
}

function AccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { user } = auth;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${user?.name ?? "signed in"}`}
        className="hover:bg-foreground/[0.05] focus-visible:ring-ring aria-expanded:bg-foreground/[0.05] flex size-9 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
      >
        <Avatar className="size-8">
          <AvatarImage src={avatarSrc(user)} />
          <AvatarFallback className="bg-primary/12 text-primary text-[11px] font-semibold">
            {initials(user?.name ?? "?")}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60">
        <p className="truncate px-2 py-2 text-[13px] font-semibold">
          {user?.name}
        </p>
        <DropdownMenuSeparator />
        <AppearanceMenuRow />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings />
          Settings
        </DropdownMenuItem>
        {user?.permissions.length ? (
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <ShieldCheck />
            Administration
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void auth.logout()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The app bar: product mark, then `children` (search), then the account menu. */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-3 lg:px-4">
      <ProductMark />
      <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>
      <AccountMenu />
    </header>
  );
}
