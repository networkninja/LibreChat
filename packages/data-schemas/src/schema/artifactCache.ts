import { Schema } from 'mongoose';
import type { IArtifactCache } from '~/types/artifactCache';

const ArtifactCacheSchema: Schema<IArtifactCache> = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    artifactId: {
      type: String,
      required: true,
      index: true,
    },
    conversationId: {
      type: String,
      index: true,
    },
    messageId: {
      type: String,
      index: true,
    },
    cacheType: {
      type: String,
      required: true,
      enum: ['selection', 'content', 'updateLocation'],
      index: true,
    },
    data: {
      type: Schema.Types.Mixed,
      required: true,
    },
    expiresAt: {
      type: Date,
      index: { expireAfterSeconds: 0 }, // MongoDB TTL index
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  },
);

// Compound indexes for efficient queries
ArtifactCacheSchema.index({ userId: 1, artifactId: 1, cacheType: 1 }, { unique: true });
ArtifactCacheSchema.index({ userId: 1, conversationId: 1 });
ArtifactCacheSchema.index({ userId: 1, messageId: 1 });

export default ArtifactCacheSchema;
