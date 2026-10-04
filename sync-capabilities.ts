/**
 * Sync protocol v2 makes the collection format an explicit part of every
 * sync request. The service keeps the highest accepted collection schema as
 * a watermark, so an old client cannot acknowledge data it cannot preserve.
 *
 * Both versions are derived from the schema ladder rather than written out, so
 * a client cannot advertise a store version it does not have.
 */
import { CLIENT_COLLECTION_SCHEMA_VERSION, SERVER_MAX_COLLECTION_SCHEMA_VERSION } from './schema-ladder.js'

export { CLIENT_COLLECTION_SCHEMA_VERSION, SERVER_MAX_COLLECTION_SCHEMA_VERSION }

export const SYNC_PROTOCOL_VERSION = 2
export const SYNC_OPERATION_BATCH_SIZE = 100
export const SYNC_CHANGE_PAGE_SIZE = 250
export const SYNC_REQUESTS_PER_ATTEMPT = 100

export interface SyncCapabilities {
  protocolVersion: number
  collectionSchemaVersion: number
}

export interface SyncHealth extends SyncCapabilities {
  ready: true
  maximumCollectionSchemaVersion: number
  store: 'sqlite'
  collectionGeneration?: string
  requiresCollectionGeneration?: boolean
}

export interface IncompatibleSync {
  code: 'client-upgrade-required' | 'server-upgrade-required' | 'protocol-upgrade-required' | 'collection-generation-required'
  message: string
  collectionGeneration?: string
  requiredSchemaVersion?: number
  maximumSchemaVersion?: number
  protocolVersion: number
}
