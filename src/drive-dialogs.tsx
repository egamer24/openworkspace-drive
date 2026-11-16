import {
  Badge,
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  responseJson,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Copy,
  Download,
  Folder,
  Link2,
  LoaderCircle,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { driveRoles, MAX_NAME_LENGTH } from "../shared/module";
import type { DriveRole } from "../shared/module";
import { filePreview } from "../shared/preview";
import {
  contentUrl,
  driveApi,
  driveKeys,
  formatBytes,
  formatDate,
  listItems,
} from "./api";
import type { DriveEntry } from "./api";

const selectClass =
  "border-input h-9 rounded-md border bg-transparent px-2 text-sm";

function roleParam(value: string): DriveRole {
  return driveRoles.find((role) => role === value) ?? "viewer";
}

export function NameDialog({
  title,
  initialName,
  submitLabel,
  onSubmit,
}: {
  title: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    // onSubmit reports its own errors.
    await onSubmit(name.trim());
    setPending(false);
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="Name"
          autoFocus
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
        />
        <DialogFooter>
          <Button type="submit" disabled={pending || !name.trim()}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Browses the folders an item can move to and moves it into the one that
 * is open: the owner's whole drive for the owner, the shared folder and
 * what is below it for an editor (`start`).
 */
export function MoveDialog({
  item,
  start,
  onMove,
}: {
  item: DriveEntry;
  start: { id: string; name: string } | null;
  onMove: (parentId: string | null) => Promise<void>;
}) {
  const [trail, setTrail] = useState(start ? [start] : []);
  const current = trail.at(-1) ?? null;

  const folders = useQuery({
    queryKey: [...driveKeys.all, "move", current?.id ?? "top"],
    queryFn: () => listItems(current ? { parentId: current.id } : {}),
  });

  const choices =
    folders.data?.items.filter(
      (entry) => entry.kind === "folder" && entry.id !== item.id
    ) ?? [];

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="truncate">Move “{item.name}”</DialogTitle>
        <DialogDescription>
          {current ? current.name : "My Drive"}
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-72 min-h-32 overflow-y-auto rounded-md border">
        {trail.length > (start ? 1 : 0) && (
          <button
            type="button"
            className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            <ChevronLeft className="size-4" /> Back
          </button>
        )}
        {folders.isPending && (
          <LoaderCircle className="text-muted-foreground m-4 size-4 animate-spin" />
        )}
        {choices.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
            onClick={() =>
              setTrail([...trail, { id: entry.id, name: entry.name }])
            }
          >
            <Folder className="text-muted-foreground size-4" />
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {folders.isSuccess && choices.length === 0 && (
          <p className="text-muted-foreground px-3 py-2 text-sm">
            No folders here
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          disabled={(current?.id ?? null) === item.parentId}
          onClick={() => void onMove(current?.id ?? null)}
        >
          Move here
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function endOfDay(date: string) {
  return date ? new Date(`${date}T23:59:59`).getTime() : null;
}

/** People and teams an item is shared with, and its public links (files only). */
export function ShareDialog({ item }: { item: DriveEntry }) {
  const client = useQueryClient();
  const queryKey = driveKeys.shares(item.id);
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<DriveRole>("viewer");
  const [access, setAccess] = useState<"download" | "view">("download");
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const shares = useQuery({
    queryKey,
    queryFn: async () =>
      responseJson(
        await driveApi.api.drive.items[":id"].shares.$get({
          param: { id: item.id },
        })
      ),
  });

  const teams = useQuery({
    queryKey: driveKeys.teams,
    queryFn: async () => responseJson(await driveApi.api.drive.teams.$get()),
  });

  const refresh = () => client.invalidateQueries({ queryKey });
  const onError = (error: Error) => toast.error(error.message);

  const share = useMutation({
    mutationFn: async (input: {
      email?: string;
      teamId?: string;
      role: DriveRole;
    }) =>
      responseJson(
        await driveApi.api.drive.items[":id"].shares.$post({
          param: { id: item.id },
          json: input,
        })
      ),
    onSuccess: async () => {
      setTarget("");
      await refresh();
    },
    onError,
  });

  const unshare = useMutation({
    mutationFn: async (shareId: string) =>
      responseJson(
        await driveApi.api.drive.items[":id"].shares[":shareId"].$delete({
          param: { id: item.id, shareId },
        })
      ),
    onSuccess: refresh,
    onError,
  });

  const createLink = useMutation({
    mutationFn: async () =>
      responseJson(
        await driveApi.api.drive.items[":id"].links.$post({
          param: { id: item.id },
          json: {
            access,
            expiresAt: endOfDay(expires),
            password: password || null,
          },
        })
      ),
    onSuccess: async (result) => {
      setCreatedUrl(result.url);
      setPassword("");
      await refresh();
    },
    onError,
  });

  const revoke = useMutation({
    mutationFn: async (id: string) =>
      responseJson(
        await driveApi.api.drive.links[":id"].$delete({ param: { id } })
      ),
    onSuccess: refresh,
    onError,
  });

  const teamId = target.startsWith("team:") ? target.slice(5) : null;

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="truncate">Share “{item.name}”</DialogTitle>
        <DialogDescription>
          People and teams you add can open this
          {item.kind === "folder" ? " folder and everything in it" : " file"}.
          Editors can also add, rename, move and trash.
        </DialogDescription>
      </DialogHeader>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          share.mutate(
            teamId ? { teamId, role } : { email: target.trim(), role }
          );
        }}
      >
        <Input
          aria-label="Person's address or team"
          list="drive-share-teams"
          placeholder="name@example.com, or pick a team"
          className="min-w-0 flex-1"
          value={
            teamId
              ? (teams.data?.teams.find((team) => team.id === teamId)?.name ??
                target)
              : target
          }
          onChange={(event) => {
            const team = teams.data?.teams.find(
              (entry) => entry.name === event.target.value
            );

            setTarget(team ? `team:${team.id}` : event.target.value);
          }}
        />
        <datalist id="drive-share-teams">
          {teams.data?.teams.map((team) => (
            <option key={team.id} value={team.name}>
              {team.name}
            </option>
          ))}
        </datalist>
        <select
          aria-label="Role"
          className={selectClass}
          value={role}
          onChange={(event) => setRole(roleParam(event.target.value))}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <Button type="submit" disabled={!target.trim() || share.isPending}>
          Share
        </Button>
      </form>
      <ul
        className="divide-y rounded-md border empty:hidden"
        aria-label="Shared with"
      >
        {shares.data?.shares.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            {entry.teamId ? (
              <Users className="text-muted-foreground size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{entry.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {entry.teamId ? "Team" : entry.email}
              </span>
            </span>
            <select
              aria-label={`Role for ${entry.name}`}
              className={selectClass}
              value={entry.role}
              onChange={(event) =>
                share.mutate(
                  entry.teamId
                    ? {
                        teamId: entry.teamId,
                        role: roleParam(event.target.value),
                      }
                    : {
                        email: entry.email ?? "",
                        role: roleParam(event.target.value),
                      }
                )
              }
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Stop sharing with ${entry.name}`}
              onClick={() => unshare.mutate(entry.id)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      {item.kind === "file" && (
        <div className="grid min-w-0 grid-cols-1 gap-3 border-t pt-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="size-4" /> Public links
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              Anyone with a link can open the file without signing in, until you
              turn the link off or it expires.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-access">Opens as</Label>
              <select
                id="drive-link-access"
                className={selectClass}
                value={access}
                onChange={(event) =>
                  setAccess(event.target.value === "view" ? "view" : "download")
                }
              >
                <option value="download">Download</option>
                <option value="view">View in browser</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-expiry">Expires</Label>
              <Input
                id="drive-link-expiry"
                type="date"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-password">Password</Label>
              <Input
                id="drive-link-password"
                type="password"
                autoComplete="new-password"
                placeholder="Optional"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <Button
            variant="outline"
            disabled={
              createLink.isPending ||
              (password.length > 0 && password.length < 4)
            }
            onClick={() => createLink.mutate()}
          >
            Create link
          </Button>
          {createdUrl && (
            <div className="bg-surface-sunken flex items-center gap-2 rounded-md border p-2">
              <code className="min-w-0 flex-1 truncate text-xs">
                {createdUrl}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(createdUrl)
                    .then(() => toast.success("Link copied"))
                }
              >
                <Copy /> Copy
              </Button>
            </div>
          )}
          <ul
            className="divide-y rounded-md border empty:hidden"
            aria-label="Public links"
          >
            {shares.data?.links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
              >
                <Badge variant="outline">
                  {link.access === "view" ? "View" : "Download"}
                </Badge>
                {link.hasPassword && <Badge variant="outline">Password</Badge>}
                <span className="text-muted-foreground">
                  {link.expiresAt
                    ? `Expires ${formatDate(link.expiresAt)}`
                    : "No expiry"}
                  {` · opened ${link.accessCount} ${link.accessCount === 1 ? "time" : "times"}`}
                </span>
                <Button
                  className="ml-auto"
                  size="sm"
                  variant="ghost"
                  onClick={() => revoke.mutate(link.id)}
                >
                  Turn off
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DialogContent>
  );
}

function TextPreview({ url }: { url: string }) {
  const text = useQuery({
    queryKey: ["drive", "text", url],
    // The first 200 KB; the rest is a download away.
    queryFn: async () => {
      const response = await fetch(url, {
        headers: { range: "bytes=0-199999" },
      });

      if (!response.ok) {
        throw new Error(`Couldn't load the file (${response.status})`);
      }

      return response.text();
    },
  });

  if (text.isPending) {
    return (
      <LoaderCircle className="text-muted-foreground m-auto size-5 animate-spin" />
    );
  }

  if (text.isError) {
    return <p className="text-destructive text-sm">{text.error.message}</p>;
  }

  return (
    <pre className="bg-surface-sunken max-h-[65dvh] overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">
      {text.data}
    </pre>
  );
}

/** Images, PDFs, text, audio and video, shown from the Worker's inline response. */
export function PreviewDialog({ item }: { item: DriveEntry }) {
  const preview = filePreview(item);
  const url = contentUrl(item.id, true);

  return (
    <DialogContent className="max-h-[95dvh] sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle className="truncate pr-8">{item.name}</DialogTitle>
        <DialogDescription>
          {formatBytes(item.size)} · {formatDate(item.updatedAt)}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-40 items-center justify-center">
        {preview?.kind === "image" && (
          <img
            src={url}
            alt={item.name}
            className="max-h-[70dvh] max-w-full object-contain"
          />
        )}
        {preview?.kind === "pdf" && (
          // oxlint-disable-next-line react/iframe-missing-sandbox -- browsers refuse to show a PDF in a sandboxed frame; the response's own CSP allows nothing to load or run
          <iframe
            src={url}
            title={item.name}
            className="h-[70dvh] w-full rounded-md border"
          />
        )}
        {preview?.kind === "text" && (
          <div className="w-full">
            <TextPreview url={url} />
          </div>
        )}
        {preview?.kind === "audio" && (
          <audio src={url} controls className="w-full">
            <track kind="captions" />
          </audio>
        )}
        {preview?.kind === "video" && (
          <video src={url} controls className="max-h-[70dvh] max-w-full">
            <track kind="captions" />
          </video>
        )}
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => window.location.assign(contentUrl(item.id))}
        >
          <Download /> Download
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
