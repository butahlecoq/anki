export interface BuildIdentity {
  version: string
  commit: string
  release: boolean
}

export const buildIdentity: BuildIdentity = {
  version: import.meta.env.VITE_KIROKU_BUILD_VERSION ?? 'development',
  commit: import.meta.env.VITE_KIROKU_BUILD_COMMIT ?? 'development',
  release: import.meta.env.PROD,
}
