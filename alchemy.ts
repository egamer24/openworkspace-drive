import { join } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import type { WorkspaceModuleInfra } from "@open-workspace/core/alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DRIVE_LINK_PATH, DRIVE_MODULE, STAGING_PREFIX } from "./shared/module";

/**
 * Drive's own bucket. Browsers upload to it with presigned PUTs, so its
 * CORS lets the app's origin PUT; downloads go through the Worker. Under
 * `alchemy dev` the app and the local S3 endpoint share an origin, so the
 * local bucket needs none. Uploads nobody completed expire after a day.
 */
function driveStorage(origin: string, dev: boolean) {
  const props: Cloudflare.R2.BucketProps = {
    lifecycleRules: [
      {
        id: "expire-unfinished-uploads",
        prefix: STAGING_PREFIX,
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 24 * 60 * 60 },
        },
      },
    ],
  };

  if (!dev) {
    props.cors = [
      {
        id: "direct-uploads",
        allowedOrigins: [origin],
        allowedMethods: ["PUT"],
        allowedHeaders: ["Content-Type"],
        maxAgeSeconds: 3600,
      },
    ];
  }

  return Cloudflare.R2.Bucket("DriveStorage", props);
}

/** The module's Worker bindings; the Worker's `Env` is derived from them (`DriveEnv`). */
const driveEnv = (origin: string) =>
  Effect.gen(function* () {
    const alchemy = yield* Effect.serviceOption(AlchemyContext);

    const bucket = driveStorage(
      origin,
      Option.isSome(alchemy) && alchemy.value.dev
    );

    return {
      DRIVE_STORAGE: bucket,
      /**
       * S3 credentials for the Drive bucket alone, as JSON, for presigned
       * uploads: from an API token Alchemy mints when deployed, the local
       * S3 endpoint under `alchemy dev`.
       */
      DRIVE_S3: Cloudflare.R2.S3Credentials(bucket, { access: "read-write" }),
    };
  });

/** The bindings `Drive()` adds, as the Worker sees them (worker/bindings.d.ts). */
export type DriveEnv = Cloudflare.InferEnv<
  Effect.Success<ReturnType<typeof driveEnv>>
>;

/**
 * Drive's Alchemy half, for `OpenWorkspace({ modules: [..., Drive()] })`:
 * its Worker code, migrations and browser app, its own R2 bucket, and the
 * `/d/<token>` prefix public links are served on.
 */
export function Drive(): WorkspaceModuleInfra {
  return {
    name: DRIVE_MODULE,
    server: { entry: join(import.meta.dirname, "index.ts") },
    routes: [DRIVE_LINK_PATH],
    migrations: join(import.meta.dirname, "migrations"),
    client: { entry: join(import.meta.dirname, "src", "client.tsx") },
    env: ({ origin }) => driveEnv(origin),
  };
}
