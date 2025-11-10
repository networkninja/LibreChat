// Service for artifact cache API communication
import { request } from 'librechat-data-provider';

export interface ArtifactCacheApiEntry {
  _id?: string;
  userId: string;
  artifactId: string;
  conversationId?: string;
  messageId?: string;
  cacheType: 'selection' | 'content' | 'updateLocation';
  data: Record<string, any>;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ArtifactCacheApiResponse {
  success: boolean;
  entry?: ArtifactCacheApiEntry;
  entries?: ArtifactCacheApiEntry[];
  deletedCount?: number;
  error?: string;
  message?: string;
}

class ArtifactCacheApiService {
  private baseUrl = '/api/artifact-cache';

  /**
   * Saves an artifact cache entry to the database
   */
  async saveEntry(
    artifactId: string,
    cacheType: 'selection' | 'content' | 'updateLocation',
    data: Record<string, any>,
    options: {
      conversationId?: string;
      messageId?: string;
      expiresAt?: Date;
    } = {},
  ): Promise<ArtifactCacheApiEntry | null> {
    try {
      const result: ArtifactCacheApiResponse = await request.post(this.baseUrl, {
        artifactId,
        cacheType,
        data,
        ...options,
      });

      if (!result.success) {
        console.error('Failed to save artifact cache entry:', result.error || result.message);
        return null;
      }

      return result.entry || null;
    } catch (error) {
      console.error('Error saving artifact cache entry:', error);
      return null;
    }
  }

  /**
   * Retrieves artifact cache entries for a specific artifact
   */
  async getEntries(
    artifactId: string,
    cacheType?: 'selection' | 'content' | 'updateLocation',
  ): Promise<ArtifactCacheApiEntry[]> {
    try {
      const encodedArtifactId = encodeURIComponent(artifactId);
      const url = `${this.baseUrl}/${encodedArtifactId}${cacheType ? `?cacheType=${cacheType}` : ''}`;
      const result: ArtifactCacheApiResponse = await request.get(url);

      if (!result.success) {
        console.error('Failed to get artifact cache entries:', result.error || result.message);
        return [];
      }

      return result.entries || [];
    } catch (error) {
      console.error('Error getting artifact cache entries:', error);
      return [];
    }
  }

  /**
   * Retrieves a specific artifact cache entry
   */
  async getEntry(
    artifactId: string,
    cacheType: 'selection' | 'content' | 'updateLocation',
  ): Promise<ArtifactCacheApiEntry | null> {
    try {
      const encodedArtifactId = encodeURIComponent(artifactId);
      const result: ArtifactCacheApiResponse = await request.get(
        `${this.baseUrl}/${encodedArtifactId}/${cacheType}`,
      );

      if (!result.success) {
        console.error('Failed to get artifact cache entry:', result.error || result.message);
        return null;
      }

      return result.entry || null;
    } catch (error) {
      console.error('Error getting artifact cache entry:', error);
      return null;
    }
  }

  /**
   * Deletes artifact cache entries
   */
  async deleteEntries(
    artifactId: string,
    cacheType?: 'selection' | 'content' | 'updateLocation',
  ): Promise<number> {
    try {
      const encodedArtifactId = encodeURIComponent(artifactId);
      const url = `${this.baseUrl}/${encodedArtifactId}${cacheType ? `?cacheType=${cacheType}` : ''}`;
      const result: ArtifactCacheApiResponse = await request.delete(url);

      if (!result.success) {
        console.error('Failed to delete artifact cache entries:', result.error || result.message);
        return 0;
      }

      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error deleting artifact cache entries:', error);
      return 0;
    }
  }

  /**
   * Deletes all artifact cache entries for the current user
   */
  async deleteAllEntries(): Promise<number> {
    try {
      const result: ArtifactCacheApiResponse = await request.delete(this.baseUrl);

      if (!result.success) {
        console.error(
          'Failed to delete all artifact cache entries:',
          result.error || result.message,
        );
        return 0;
      }

      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error deleting all artifact cache entries:', error);
      return 0;
    }
  }

  /**
   * Retrieves all artifact cache entries for a conversation
   */
  async getConversationEntries(conversationId: string): Promise<ArtifactCacheApiEntry[]> {
    try {
      const result: ArtifactCacheApiResponse = await request.get(
        `${this.baseUrl}/conversation/${conversationId}`,
      );

      if (!result.success) {
        console.error(
          'Failed to get conversation artifact cache entries:',
          result.error || result.message,
        );
        return [];
      }

      return result.entries || [];
    } catch (error) {
      console.error('Error getting conversation artifact cache entries:', error);
      return [];
    }
  }

  /**
   * Cleans up expired cache entries (admin function)
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result: ArtifactCacheApiResponse = await request.post(`${this.baseUrl}/cleanup`);

      if (!result.success) {
        console.error('Failed to cleanup expired cache entries:', result.error || result.message);
        return 0;
      }

      return result.deletedCount || 0;
    } catch (error) {
      console.error('Error cleaning up expired cache entries:', error);
      return 0;
    }
  }
}

// Export a singleton instance
export const artifactCacheApi = new ArtifactCacheApiService();
