// Minimal sandboxed preload (CommonJS emit, see tsconfig.preload.json).
//
// It sets exactly one frozen, non-privileged marker so integration tests can
// prove the preload executed and was loaded as CJS (an ESM emit would fail
// to load under sandbox:true and no marker would appear).
//
// Two projections of the same marker exist because contextIsolation runs the
// preload in an isolated JavaScript world: a plain window expando is visible
// only inside the preload world, so the cross-world observable witness is a
// shared-DOM attribute carrying the same fixed value.

declare const window: unknown;
declare const document:
  | {
      readonly documentElement: {
        setAttribute(qualifiedName: string, value: string): void;
      } | null;
      addEventListener(
        type: string,
        listener: () => void,
        options?: { once?: boolean },
      ): void;
    }
  | undefined;

const PRELOAD_WITNESS_VALUE = "preload-loaded";

const scope = window as unknown as Record<string, unknown>;
const hostMarker = { preloadLoaded: true };
Object.freeze(hostMarker);
scope.__youtubeTvHost = hostMarker;

function stampDocument(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (document.documentElement !== null) {
    document.documentElement.setAttribute(
      "data-youtube-tv-host",
      PRELOAD_WITNESS_VALUE,
    );
    return;
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (
        typeof document !== "undefined" &&
        document.documentElement !== null
      ) {
        document.documentElement.setAttribute(
          "data-youtube-tv-host",
          PRELOAD_WITNESS_VALUE,
        );
      }
    },
    { once: true },
  );
}

stampDocument();
