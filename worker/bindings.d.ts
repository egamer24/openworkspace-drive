import type { DriveEnv } from "../alchemy";

declare global {
  /** Drive's bindings, derived from what `Drive()` declares (`DriveEnv`). */
  interface Env extends DriveEnv {}
}
