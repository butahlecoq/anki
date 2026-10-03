/**
 * Sync protocol v2 makes the collection format an explicit part of every
 * sync request. The service keeps the highest accepted collection schema as
 * a watermark, so an old client cannot acknowledge data it cannot preserve.
 */
export const SYNC_PROTOCOL_VERSION = 2
export const CLIENT_COLLECTION_SCHEMA_VERSION = 16
export const SERVER_MAX_COLLECTION_SCHEMA_VERSION = 16

export interface SyncCapabilities {
  protocolVersion: number
  collectionSchemaVersion: number
}

export interface SyncHealth extends SyncCapabilities {
  ready: true
  maximumCollectionSchemaVersion: number
  store: 'sqlite'
}

export interface IncompatibleSync {
  code: 'client-upgrade-required' | 'server-upgrade-required' | 'protocol-upgrade-required'
  message: string
  requiredSchemaVersion?: number
  maximumSchemaVersion?: number
  protocolVersion: number
}
