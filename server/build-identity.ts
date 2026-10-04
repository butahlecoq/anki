export interface BuildIdentity {
  version: string
  commit: string
  release: boolean
}

export function readBuildIdentity(): BuildIdentity {
  const version = process.env.KIROKU_BUILD_VERSION ?? 'development'
  const commit = process.env.KIROKU_BUILD_COMMIT ?? 'development'
  return { version, commit, release: process.env.KIROKU_BUILD_RELEASE === 'true' }
}
