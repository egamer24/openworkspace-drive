import {
  adminListClass,
  Button,
  Input,
  Label,
  responseJson,
  Skeleton,
  useConfirm,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { driveApi, driveKeys, formatBytes } from "./api";

const GB = 1_000_000_000;

function gigabytes(value: string) {
  return Math.round(Number(value) * GB);
}

/**
 * Administration → Drive, for members given "Manage Drive": the default
 * quota, each person's usage and quota, and erasing a person's files.
 * Core lists the section only for them, and the routes check it again.
 */
export function DriveAdmin() {
  const client = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const state = useQuery({
    queryKey: driveKeys.admin,
    queryFn: async () => responseJson(await driveApi.api.admin.drive.$get()),
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: driveKeys.admin });
    await client.invalidateQueries({ queryKey: driveKeys.all });
  };

  const onError = (error: Error) => toast.error(error.message);

  const saveDefault = useMutation({
    mutationFn: async (defaultQuotaBytes: number) =>
      responseJson(
        await driveApi.api.admin.drive.settings.$put({
          json: { defaultQuotaBytes },
        })
      ),
    onSuccess: async () => {
      toast.success("Default quota saved");
      await refresh();
    },
    onError,
  });

  const saveQuota = useMutation({
    mutationFn: async (input: { userId: string; quotaBytes: number | null }) =>
      responseJson(
        await driveApi.api.admin.drive.quotas[":userId"].$put({
          param: { userId: input.userId },
          json: { quotaBytes: input.quotaBytes },
        })
      ),
    onSuccess: async () => {
      toast.success("Quota saved");
      await refresh();
    },
    onError,
  });

  const erase = useMutation({
    mutationFn: async (userId: string) =>
      responseJson(
        await driveApi.api.admin.drive.people[":userId"].files.$delete({
          param: { userId },
        })
      ),
    onSuccess: async (result) => {
      toast.success(
        `Deleted ${result.deleted} ${result.deleted === 1 ? "item" : "items"}`
      );
      await refresh();
    },
    onError,
  });

  if (state.isPending) return <Skeleton className="h-40 rounded-xl" />;

  if (state.isError) {
    return <p className="text-destructive text-sm">{state.error.message}</p>;
  }

  const { defaultQuotaBytes, people } = state.data;

  return (
    <div className="space-y-6">
      <DefaultQuota
        key={defaultQuotaBytes}
        bytes={defaultQuotaBytes}
        pending={saveDefault.isPending}
        onSave={(bytes) => saveDefault.mutate(bytes)}
      />
      <ul className={adminListClass} aria-label="People">
        {people.map((person) => (
          <QuotaRow
            key={`${person.userId}:${person.quotaBytes}`}
            person={person}
            defaultQuotaBytes={defaultQuotaBytes}
            pending={saveQuota.isPending}
            onSave={(quotaBytes) =>
              saveQuota.mutate({ userId: person.userId, quotaBytes })
            }
            onErase={async () => {
              const confirmed = await confirm({
                title: `Delete all of ${person.name}'s files?`,
                description:
                  "Everything in their Drive is deleted for good: files, folders, the trash, and the shares and public links on them. Files they added to other people's folders stay with those people.",
                action: "Delete their files",
                destructive: true,
              });

              if (confirmed) erase.mutate(person.userId);
            }}
          />
        ))}
      </ul>
      {dialog}
    </div>
  );
}

function DefaultQuota({
  bytes,
  pending,
  onSave,
}: {
  bytes: number;
  pending: boolean;
  onSave: (bytes: number) => void;
}) {
  const [value, setValue] = useState(String(bytes / GB));

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(gigabytes(value));
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="drive-default-quota">
          Default quota per person (GB)
        </Label>
        <Input
          id="drive-default-quota"
          className="w-32"
          type="number"
          min="0"
          step="any"
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

function QuotaRow({
  person,
  defaultQuotaBytes,
  pending,
  onSave,
  onErase,
}: {
  person: {
    userId: string;
    name: string;
    status: string;
    usedBytes: number;
    quotaBytes: number | null;
  };
  defaultQuotaBytes: number;
  pending: boolean;
  onSave: (quotaBytes: number | null) => void;
  onErase: () => Promise<void>;
}) {
  const [value, setValue] = useState(
    person.quotaBytes === null ? "" : String(person.quotaBytes / GB)
  );

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{person.name}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatBytes(person.usedBytes)} of{" "}
          {formatBytes(person.quotaBytes ?? defaultQuotaBytes)}
          {person.status === "active" ? "" : ` · ${person.status}`}
        </span>
      </span>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(value.trim() === "" ? null : gigabytes(value));
        }}
      >
        <Input
          aria-label={`Quota for ${person.name} in GB`}
          className="h-8 w-24"
          type="number"
          min="0"
          step="any"
          placeholder="Default"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="text-muted-foreground text-xs">GB</span>
        <Button size="sm" variant="outline" type="submit" disabled={pending}>
          Save
        </Button>
      </form>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={() => void onErase()}
      >
        Delete files
      </Button>
    </li>
  );
}
