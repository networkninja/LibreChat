import type { FilterQuery } from 'mongoose';
import type { ArtifactCacheEntry, IArtifactCache } from '~/types/artifactCache';

// Factory function that takes mongoose instance and returns the methods
export function createArtifactCacheMethods(mongoose: typeof import('mongoose')) {
  /**
   * Creates or updates an artifact cache entry
   * @param entry - The artifact cache entry to save
   * @returns Promise<IArtifactCache | null>
   */
  async function saveArtifactCache(entry: ArtifactCacheEntry): Promise<IArtifactCache | null> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const result = await ArtifactCache.findOneAndUpdate(
        {
          userId: entry.userId,
          artifactId: entry.artifactId,
          cacheType: entry.cacheType,
        },
        {
          ...entry,
          updatedAt: new Date(),
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
        },
      );

      return result;
    } catch (error) {
      console.error('Error saving artifact cache:', error);
      return null;
    }
  }

  /**
   * Retrieves artifact cache entries for a user and artifact
   * @param userId - User ID
   * @param artifactId - Artifact ID
   * @param cacheType - Optional specific cache type to filter
   * @returns Promise<IArtifactCache[]>
   */
  async function getArtifactCache(
    userId: string,
    artifactId: string,
    cacheType?: string,
  ): Promise<IArtifactCache[]> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const query: FilterQuery<IArtifactCache> = {
        userId,
        artifactId,
      };

      if (cacheType) {
        query.cacheType = cacheType;
      }

      const results = await ArtifactCache.find(query).sort({ updatedAt: -1 });
      return results;
    } catch (error) {
      console.error('Error retrieving artifact cache:', error);
      return [];
    }
  }

  /**
   * Retrieves a specific artifact cache entry
   * @param userId - User ID
   * @param artifactId - Artifact ID
   * @param cacheType - Cache type
   * @returns Promise<IArtifactCache | null>
   */
  async function getArtifactCacheEntry(
    userId: string,
    artifactId: string,
    cacheType: 'selection' | 'content' | 'updateLocation',
  ): Promise<IArtifactCache | null> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const result = await ArtifactCache.findOne({
        userId,
        artifactId,
        cacheType,
      });

      return result;
    } catch (error) {
      console.error('Error retrieving artifact cache entry:', error);
      return null;
    }
  }

  /**
   * Deletes artifact cache entries
   * @param userId - User ID
   * @param artifactId - Artifact ID
   * @param cacheType - Optional specific cache type to delete
   * @returns Promise<number> - Number of deleted entries
   */
  async function deleteArtifactCache(
    userId: string,
    artifactId: string,
    cacheType?: string,
  ): Promise<number> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const query: FilterQuery<IArtifactCache> = {
        userId,
        artifactId,
      };

      if (cacheType) {
        query.cacheType = cacheType;
      }

      const result = await ArtifactCache.deleteMany(query);
      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error deleting artifact cache:', error);
      return 0;
    }
  }

  /**
   * Deletes all artifact cache entries for a user
   * @param userId - User ID
   * @returns Promise<number> - Number of deleted entries
   */
  async function deleteAllUserArtifactCache(userId: string): Promise<number> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const result = await ArtifactCache.deleteMany({ userId });
      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error deleting all user artifact cache:', error);
      return 0;
    }
  }

  /**
   * Retrieves all artifact cache entries for a conversation
   * @param userId - User ID
   * @param conversationId - Conversation ID
   * @returns Promise<IArtifactCache[]>
   */
  async function getConversationArtifactCache(
    userId: string,
    conversationId: string,
  ): Promise<IArtifactCache[]> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const results = await ArtifactCache.find({
        userId,
        conversationId,
      }).sort({ updatedAt: -1 });

      return results;
    } catch (error) {
      console.error('Error retrieving conversation artifact cache:', error);
      return [];
    }
  }

  /**
   * Cleans up expired artifact cache entries
   * @returns Promise<number> - Number of deleted entries
   */
  async function cleanupExpiredArtifactCache(): Promise<number> {
    try {
      const ArtifactCache = mongoose.models.ArtifactCache;

      const result = await ArtifactCache.deleteMany({
        expiresAt: { $lt: new Date() },
      });

      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error cleaning up expired artifact cache:', error);
      return 0;
    }
  }

  return {
    saveArtifactCache,
    getArtifactCache,
    getArtifactCacheEntry,
    deleteArtifactCache,
    deleteAllUserArtifactCache,
    getConversationArtifactCache,
    cleanupExpiredArtifactCache,
  };
}

export type ArtifactCacheMethods = ReturnType<typeof createArtifactCacheMethods>;
