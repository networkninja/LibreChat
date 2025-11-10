import type { Document, Types } from 'mongoose';

export type ArtifactCacheEntry = {
  /** User ID who owns this cache entry */
  userId: string;
  /** Artifact identifier this cache is for */
  artifactId: string;
  /** Conversation ID for context */
  conversationId?: string;
  /** Message ID for context */
  messageId?: string;
  /** Type of cache entry */
  cacheType: 'selection' | 'content' | 'updateLocation';
  /** The cached data as JSON */
  data: Record<string, unknown>;
  /** When this cache entry expires (optional) */
  expiresAt?: Date;
};

export type IArtifactCache = ArtifactCacheEntry &
  Document & {
    _id: Types.ObjectId;
  };
