/** Build stamp injected by Vite `define` (see `vite.config.ts`). */
export type AppBuildInfo = {
  readonly version: string;
  readonly commitDate: string;
};

declare const __APP_BUILD_INFO__: AppBuildInfo | undefined;

const fallbackBuildInfo: AppBuildInfo = { version: "dev", commitDate: "" };

/** The version/date of the commit this copy was built from; "dev" when unknown. */
export const appBuildInfo: AppBuildInfo =
  typeof __APP_BUILD_INFO__ !== "undefined"
    ? __APP_BUILD_INFO__
    : fallbackBuildInfo;
