import {
  Button,
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  responseJson,
  useConfirm,
  useDebouncedValue,
} from "@open-workspace/core/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { driveSorts, driveViews, MAX_UPLOAD_BYTES } from "../shared/module";
import { filePreview } from "../shared/preview";
import {
  contentUrl,
  driveApi,
  driveKeys,
  formatBytes,
  formatDate,
  listItems,
  putFile,
} from "./api";
import type { DriveEntry } from "./api";
import { AppHeader } from "./app-header";
import {
  MoveDialog,
  NameDialog,
  PreviewDialog,
  ShareDialog,
} from "./drive-dialogs";

type View = (typeof driveViews)[number];

type Sort = (typeof driveSorts)[number];

type DialogState =
  | { type: "folder" }
  | { type: "rename" | "move" | "share" | "preview"; item: DriveEntry }
  | null;

const views: { id: View; label: string; Icon: typeof HardDrive }[] = [
  { id: "files", label: "My Drive", Icon: HardDrive },
  { id: "shared", label: "Shared with me", Icon: Users },
  { id: "trash", label: "Trash", Icon: Trash2 },
];

const sortLabels: Record<Sort, string> = {
  name: "Name",
  date: "Modified",
  size: "Size",
};

function viewParam(value: string | null): View {
  return driveViews.find((view) => view === value) ?? "files";
}

function sortParam(value: string): Sort {
  return driveSorts.find((sort) => sort === value) ?? "name";
}

function download(item: DriveEntry) {
  window.location.assign(contentUrl(item.id));
}

/** The app, at /drive: your files, what's shared with you, and the trash. */
export function DrivePage() {
  const client = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const view = viewParam(params.get("view"));
  const folderId = params.get("folder") ?? undefined;
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);
  const [sort, setSort] = useState<Sort>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [dialog, setDialog] = useState<DialogState>(null);

  const [uploads, setUploads] = useState<
    { id: number; name: string; progress: number }[]
  >([]);

  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const searching = view === "files" && query.length > 0;

  const status = useQuery({
    queryKey: driveKeys.status,
    queryFn: async () => responseJson(await driveApi.api.drive.status.$get()),
  });

  const listing = useQuery({
    queryKey: [
      ...driveKeys.all,
      "list",
      view,
      folderId ?? null,
      searching ? query : null,
      sort,
      order,
    ],
    queryFn: () =>
      listItems({
        view,
        parentId: searching ? undefined : folderId,
        search: searching ? query : undefined,
        sort,
        order,
      }),
  });

  const refresh = () => client.invalidateQueries({ queryKey: driveKeys.all });

  async function run(action: () => Promise<object>, success?: string) {
    try {
      await action();

      if (success) toast.success(success);
      setDialog(null);
      await refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong"
      );
    }
  }

  function open(next: { view?: View; folder?: string }) {
    setSearch("");
    const nextParams = new URLSearchParams();

    if (next.view && next.view !== "files") nextParams.set("view", next.view);

    if (next.folder) nextParams.set("folder", next.folder);
    setParams(nextParams);
  }

  const access = listing.data?.access ?? "owner";

  const canWriteHere =
    view !== "trash" &&
    !searching &&
    (view === "files" || folderId !== undefined) &&
    (access === "owner" || access === "editor");

  const parentId = folderId ?? null;

  async function uploadOne(file: File, id: number) {
    const intent = await responseJson(
      await driveApi.api.drive.uploads.$post({
        json: {
          parentId,
          name: file.name,
          contentType: file.type,
          size: file.size,
        },
      })
    );

    await putFile(intent.upload, file, (progress) =>
      setUploads((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, progress } : entry
        )
      )
    );
    await responseJson(
      await driveApi.api.drive.uploads[":id"].complete.$post({
        param: { id: intent.item.id },
      })
    );
  }

  async function uploadFiles(files: File[]) {
    for (const [index, file] of files.entries()) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(
          `${file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`
        );
        continue;
      }

      const id = Date.now() + index;
      setUploads((current) => [
        ...current,
        { id, name: file.name, progress: 0 },
      ]);

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one upload at a time keeps the quota check honest and the list readable
        await uploadOne(file, id);
      } catch (error) {
        toast.error(
          `${file.name}: ${error instanceof Error ? error.message : "upload failed"}`
        );
      }

      setUploads((current) => current.filter((entry) => entry.id !== id));
    }

    await refresh();
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);

    if (canWriteHere && event.dataTransfer.files.length > 0) {
      void uploadFiles([...event.dataTransfer.files]);
    }
  }

  function openItem(item: DriveEntry) {
    if (view === "trash") return;

    if (item.kind === "folder") {
      open({ view: view === "shared" ? "shared" : "files", folder: item.id });
    } else if (filePreview(item)) {
      setDialog({ type: "preview", item });
    } else {
      download(item);
    }
  }

  async function deleteForever(item: DriveEntry) {
    const confirmed = await confirm({
      title: `Delete “${item.name}” forever?`,
      description:
        item.kind === "folder"
          ? "The folder and everything in it are deleted for good, with any public links."
          : "The file is deleted for good, with any public links.",
      action: "Delete forever",
      destructive: true,
    });

    if (!confirmed) return;

    await run(
      async () =>
        responseJson(
          await driveApi.api.drive.items[":id"].$delete({
            param: { id: item.id },
          })
        ),
      "Deleted"
    );
  }

  const crumbs = [
    ...(listing.data?.path ?? []),
    ...(listing.data?.folder ? [listing.data.folder] : []),
  ];

  const viewLabel =
    views.find((entry) => entry.id === view)?.label ?? "My Drive";

  return (
    <div className="bg-background flex h-dvh flex-col">
      <AppHeader>
        {view === "files" && (
          <label className="relative hidden w-64 sm:block">
            <span className="sr-only">Search your files</span>
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              className="bg-surface-sunken h-9 pl-9"
              placeholder="Search your files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
      </AppHeader>

      <div
        className="flex min-h-0 flex-1 flex-col sm:flex-row"
        onDragOver={(event) => {
          if (!canWriteHere) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <nav
          aria-label="Drive"
          className="flex shrink-0 gap-1 overflow-x-auto p-2 sm:w-56 sm:flex-col sm:p-3"
        >
          <Button
            className="mb-2 hidden justify-start sm:flex"
            disabled={!canWriteHere}
            onClick={() => fileInput.current?.click()}
          >
            <Upload /> Upload
          </Button>
          {views.map(({ id, label, Icon }) => (
            <Button
              key={id}
              variant="ghost"
              aria-current={view === id && !searching ? "page" : undefined}
              className={cn(
                "justify-start",
                view === id && !searching && "bg-accent font-semibold"
              )}
              onClick={() => open({ view: id })}
            >
              <Icon /> {label}
            </Button>
          ))}
          {status.data && (
            <div className="hidden px-3 pt-4 sm:block">
              <div
                className="bg-muted h-1.5 overflow-hidden rounded-full"
                role="meter"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={status.data.quotaBytes}
                aria-valuenow={status.data.usedBytes}
              >
                <div
                  className="bg-primary h-full"
                  style={{
                    width: `${Math.min(100, (status.data.usedBytes / Math.max(1, status.data.quotaBytes)) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                {formatBytes(status.data.usedBytes)} of{" "}
                {formatBytes(status.data.quotaBytes)} used
              </p>
            </div>
          )}
        </nav>

        <main
          className={cn(
            "bg-surface m-0 min-h-0 min-w-0 flex-1 overflow-y-auto sm:mr-3 sm:mb-3 sm:rounded-xl sm:border",
            dragging && "ring-primary ring-2"
          )}
        >
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <nav
              aria-label="Folder path"
              className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm"
            >
              <button
                type="button"
                className="font-semibold hover:underline"
                onClick={() => open({ view })}
              >
                {searching ? `Results for “${query}”` : viewLabel}
              </button>
              {!searching &&
                crumbs.map((crumb) => (
                  <span
                    key={crumb.id}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <ChevronRight className="text-muted-foreground size-3.5" />
                    <button
                      type="button"
                      className="truncate hover:underline"
                      onClick={() =>
                        open({
                          view: view === "shared" ? "shared" : "files",
                          folder: crumb.id,
                        })
                      }
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
            </nav>
            <select
              aria-label="Sort by"
              className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
              value={sort}
              onChange={(event) => setSort(sortParam(event.target.value))}
            >
              {driveSorts.map((value) => (
                <option key={value} value={value}>
                  {sortLabels[value]}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
            >
              {order === "asc" ? "Ascending" : "Descending"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWriteHere}
              onClick={() => setDialog({ type: "folder" })}
            >
              <FolderPlus />{" "}
              <span className="hidden sm:inline">New folder</span>
            </Button>
            <Button
              size="sm"
              className="sm:hidden"
              disabled={!canWriteHere}
              onClick={() => fileInput.current?.click()}
            >
              <Upload /> Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) {
                  void uploadFiles([...event.target.files]);
                }

                event.target.value = "";
              }}
            />
          </div>

          {uploads.map((entry) => (
            <div
              key={entry.id}
              role="status"
              className="mx-4 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            >
              <LoaderCircle className="size-3.5 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="tabular-nums">
                {Math.round(entry.progress * 100)}%
              </span>
            </div>
          ))}

          {listing.isPending && (
            <LoaderCircle className="text-muted-foreground mx-auto my-10 size-5 animate-spin" />
          )}
          {listing.isError && (
            <p role="alert" className="text-destructive px-4 text-sm">
              {listing.error.message}
            </p>
          )}
          {listing.isSuccess && listing.data.items.length === 0 && (
            <p className="text-muted-foreground px-4 py-16 text-center text-sm">
              {view === "trash"
                ? "The trash is empty."
                : view === "shared" && !folderId
                  ? "Nothing has been shared with you yet."
                  : canWriteHere
                    ? "Nothing here yet. Upload files, or drop them here."
                    : "Nothing here."}
            </p>
          )}
          <ul className="divide-y border-t empty:hidden">
            {listing.data?.items.map((item) => (
              <li
                key={item.id}
                className="hover:bg-accent/50 flex items-center gap-3 px-4 py-2 text-sm"
              >
                {item.kind === "folder" ? (
                  <Folder className="text-primary size-4 shrink-0" />
                ) : (
                  <File className="text-muted-foreground size-4 shrink-0" />
                )}
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  disabled={view === "trash"}
                  onClick={() => openItem(item)}
                >
                  {item.name}
                </button>
                {view === "shared" && (
                  <span className="text-muted-foreground hidden w-32 truncate text-xs md:block">
                    {item.ownerName}
                  </span>
                )}
                <span className="text-muted-foreground hidden w-20 text-right text-xs tabular-nums sm:block">
                  {item.kind === "file" ? formatBytes(item.size) : ""}
                </span>
                <span className="text-muted-foreground hidden w-28 text-right text-xs md:block">
                  {formatDate(item.updatedAt)}
                </span>
                <ItemMenu
                  item={item}
                  view={view}
                  onRename={() => setDialog({ type: "rename", item })}
                  onMove={() => setDialog({ type: "move", item })}
                  onShare={() => setDialog({ type: "share", item })}
                  onTrash={() =>
                    void run(
                      async () =>
                        responseJson(
                          await driveApi.api.drive.items[":id"].trash.$post({
                            param: { id: item.id },
                          })
                        ),
                      "Moved to the trash"
                    )
                  }
                  onRestore={() =>
                    void run(
                      async () =>
                        responseJson(
                          await driveApi.api.drive.items[":id"].restore.$post({
                            param: { id: item.id },
                          })
                        ),
                      "Restored"
                    )
                  }
                  onDelete={() => void deleteForever(item)}
                />
              </li>
            ))}
          </ul>
        </main>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      >
        {dialog?.type === "folder" && (
          <NameDialog
            title="New folder"
            initialName=""
            submitLabel="Create"
            onSubmit={(name) =>
              run(async () =>
                responseJson(
                  await driveApi.api.drive.folders.$post({
                    json: { parentId, name },
                  })
                )
              )
            }
          />
        )}
        {dialog?.type === "rename" && (
          <NameDialog
            title="Rename"
            initialName={dialog.item.name}
            submitLabel="Rename"
            onSubmit={(name) =>
              run(async () =>
                responseJson(
                  await driveApi.api.drive.items[":id"].$patch({
                    param: { id: dialog.item.id },
                    json: { name },
                  })
                )
              )
            }
          />
        )}
        {dialog?.type === "move" && (
          <MoveDialog
            item={dialog.item}
            start={view === "shared" ? (crumbs[0] ?? null) : null}
            onMove={(target) =>
              run(
                async () =>
                  responseJson(
                    await driveApi.api.drive.items[":id"].$patch({
                      param: { id: dialog.item.id },
                      json: { parentId: target },
                    })
                  ),
                "Moved"
              )
            }
          />
        )}
        {dialog?.type === "share" && <ShareDialog item={dialog.item} />}
        {dialog?.type === "preview" && <PreviewDialog item={dialog.item} />}
      </Dialog>
      {confirmDialog}
    </div>
  );
}

function ItemMenu({
  item,
  view,
  onRename,
  onMove,
  onShare,
  onTrash,
  onRestore,
  onDelete,
}: {
  item: DriveEntry;
  view: View;
  onRename: () => void;
  onMove: () => void;
  onShare: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const editable = item.access === "owner" || item.access === "editor";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${item.name}`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view === "trash" ? (
          <>
            <DropdownMenuItem onClick={onRestore}>
              <RotateCcw /> Restore
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete forever
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {item.kind === "file" && (
              <DropdownMenuItem onClick={() => download(item)}>
                <Download /> Download
              </DropdownMenuItem>
            )}
            {item.access === "owner" && (
              <DropdownMenuItem onClick={onShare}>
                <Share2 /> Share
              </DropdownMenuItem>
            )}
            {editable && (
              <>
                <DropdownMenuItem onClick={onRename}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onMove}>
                  <FolderInput /> Move
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onTrash}>
                  <Trash2 /> Move to the trash
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
