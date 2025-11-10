// Enhanced cache system for artifact updates
import { artifactCacheApi } from '~/routes/ArtifactCacheApi';

export interface ArtifactSelectionContext {
  updatedText?: string;
  fileKey: string;
  originalText: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  artifactId?: string;
  artifactIndex?: number;
  artifactMessageId?: string;
  timestamp?: number;
}

export interface ArtifactContentCache {
  content: string;
  title?: string;
  type?: string;
  identifier?: string;
  timestamp: number;
  source: 'directive' | 'editor' | 'api';
  creationTime?: number; // Added creationTime for artifact cache entries
  // Optional line information for partial updates
  lineInfo?: {
    startLine: number;
    endLine: number;
    startColumn?: number;
    endColumn?: number;
  };
}

export interface ArtifactUpdateLocation {
  startLine: number;
  endLine: number;
  updatedLines: number;
  updateType: 'partial' | 'full';
  timestamp: number;
}

export interface ArtifactCacheStatus {
  hasSelection: boolean;
  hasContent: boolean;
  selectionValid: boolean;
  contentValid: boolean;
  selection?: ArtifactSelectionContext;
  content?: ArtifactContentCache;
}

// Enhanced cache for artifact updates - supports both selection context and content caching
export const artifactCache = {
  _selectionCache: new Map<string, ArtifactSelectionContext>(),
  _contentCache: new Map<string, ArtifactContentCache>(),
  _updateLocationCache: new Map<string, ArtifactUpdateLocation>(),

  // Persistence helper methods
  _saveToStorage: () => {
    try {
      const selectionData = Array.from(artifactCache._selectionCache.entries());
      const contentData = Array.from(artifactCache._contentCache.entries());
      const updateLocationData = Array.from(artifactCache._updateLocationCache.entries());

      localStorage.setItem('artifactCache_selections', JSON.stringify(selectionData));
      localStorage.setItem('artifactCache_content', JSON.stringify(contentData));
      localStorage.setItem('artifactCache_updateLocations', JSON.stringify(updateLocationData));

      console.log('💾 [ArtifactCache] Saved to localStorage:', {
        selections: selectionData.length,
        content: contentData.length,
        updateLocations: updateLocationData.length,
      });
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to save to localStorage:', error);
    }
  },

  _loadFromStorage: () => {
    try {
      const selectionData = localStorage.getItem('artifactCache_selections');
      const contentData = localStorage.getItem('artifactCache_content');
      const updateLocationData = localStorage.getItem('artifactCache_updateLocations');

      if (selectionData) {
        const selections = JSON.parse(selectionData);
        artifactCache._selectionCache = new Map(selections);
      }

      if (contentData) {
        const content = JSON.parse(contentData);
        artifactCache._contentCache = new Map(content);
      }

      if (updateLocationData) {
        const updateLocations = JSON.parse(updateLocationData);
        artifactCache._updateLocationCache = new Map(updateLocations);
      }

      console.log('📂 [ArtifactCache] Loaded from localStorage:', {
        selections: artifactCache._selectionCache.size,
        content: artifactCache._contentCache.size,
        updateLocations: artifactCache._updateLocationCache.size,
      });
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to load from localStorage:', error);
    }
  },

  _clearStorage: () => {
    try {
      localStorage.removeItem('artifactCache_selections');
      localStorage.removeItem('artifactCache_content');
      localStorage.removeItem('artifactCache_updateLocations');
      console.log('🗑️ [ArtifactCache] Cleared localStorage');
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to clear localStorage:', error);
    }
  },

  // MongoDB persistence methods (cross-device synchronization)
  _syncToDatabase: async (
    artifactId: string,
    cacheType: 'selection' | 'content' | 'updateLocation',
    data: any,
    options: { conversationId?: string; messageId?: string } = {},
  ) => {
    try {
      const result = await artifactCacheApi.saveEntry(artifactId, cacheType, data, options);
      if (result) {
        console.log('🌐 [ArtifactCache] Synced to database:', { artifactId, cacheType });
      }
      return result;
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to sync to database:', error);
      return null;
    }
  },

  _loadFromDatabase: async (
    artifactId: string,
    cacheType?: 'selection' | 'content' | 'updateLocation',
  ) => {
    try {
      const entries = await artifactCacheApi.getEntries(artifactId, cacheType);

      for (const entry of entries) {
        switch (entry.cacheType) {
          case 'selection':
            artifactCache._selectionCache.set(artifactId, entry.data as ArtifactSelectionContext);
            break;
          case 'content':
            artifactCache._contentCache.set(artifactId, entry.data as ArtifactContentCache);
            break;
          case 'updateLocation':
            artifactCache._updateLocationCache.set(
              artifactId,
              entry.data as ArtifactUpdateLocation,
            );
            break;
        }
      }

      console.log('📥 [ArtifactCache] Loaded from database:', {
        artifactId,
        entriesCount: entries.length,
      });

      // Also save to localStorage for offline access
      artifactCache._saveToStorage();

      return entries;
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to load from database:', error);
      return [];
    }
  },

  _deleteFromDatabase: async (
    artifactId: string,
    cacheType?: 'selection' | 'content' | 'updateLocation',
  ) => {
    try {
      const deletedCount = await artifactCacheApi.deleteEntries(artifactId, cacheType);
      console.log('🗑️ [ArtifactCache] Deleted from database:', {
        artifactId,
        cacheType,
        deletedCount,
      });
      return deletedCount;
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to delete from database:', error);
      return 0;
    }
  },

  // Selection context methods (for editor-based partial updates)
  setSelection: (artifactId: string, context: Omit<ArtifactSelectionContext, 'timestamp'>) => {
    const selectionData = {
      ...context,
      timestamp: Date.now(),
    };

    artifactCache._selectionCache.set(artifactId, selectionData);
    artifactCache._saveToStorage(); // Persist to localStorage

    // Also sync to MongoDB for cross-device access
    artifactCache._syncToDatabase(artifactId, 'selection', selectionData, {
      conversationId: context.artifactMessageId,
      messageId: context.artifactMessageId,
    });
  },

  getSelection: (artifactId: string): ArtifactSelectionContext | undefined => {
    return artifactCache._selectionCache.get(artifactId);
  },

  isSelectionValid: (artifactId: string, maxAge = 30000): boolean => {
    const entry = artifactCache._selectionCache.get(artifactId);
    if (!entry) return false;
    return Date.now() - (entry.timestamp || 0) < maxAge;
  },

  clearSelection: (artifactId: string) => {
    artifactCache._selectionCache.delete(artifactId);
    artifactCache._saveToStorage(); // Persist to localStorage
  },

  // Content caching methods (for artifactupdate directives and full content)
  setContent: (
    artifactId: string,
    content: string,
    metadata: Partial<ArtifactContentCache> = {},
  ) => {
    // Check if an entry already exists to preserve creationTime
    const existing = artifactCache._contentCache.get(artifactId);
    const contentData = {
      content,
      timestamp: Date.now(),
      source: 'directive' as const,
      creationTime: existing?.creationTime || Date.now(),
      ...metadata,
    };

    artifactCache._contentCache.set(artifactId, contentData);
    artifactCache._saveToStorage(); // Persist to localStorage

    // Also sync to MongoDB for cross-device access
    artifactCache._syncToDatabase(artifactId, 'content', contentData, {
      conversationId: metadata.identifier,
    });
  },

  // Enhanced method to cache content with line information
  setContentWithLines: (
    artifactId: string,
    content: string,
    lineInfo: { startLine: number; endLine: number; startColumn?: number; endColumn?: number },
    metadata: Partial<ArtifactContentCache> = {},
  ) => {
    // Check if an entry already exists to preserve creationTime
    const existing = artifactCache._contentCache.get(artifactId);
    artifactCache._contentCache.set(artifactId, {
      content,
      timestamp: Date.now(),
      source: 'editor',
      creationTime: existing?.creationTime || Date.now(),
      lineInfo,
      ...metadata,
    });
    artifactCache._saveToStorage(); // Persist to localStorage
  },

  getContent: (artifactId: string): ArtifactContentCache | undefined => {
    return artifactCache._contentCache.get(artifactId);
  },

  isContentValid: (artifactId: string, maxAge = 300000): boolean => {
    // 5 minutes for content cache
    const entry = artifactCache._contentCache.get(artifactId);
    if (!entry) return false;
    return Date.now() - entry.timestamp < maxAge;
  },

  clearContent: (artifactId: string) => {
    artifactCache._contentCache.delete(artifactId);
    artifactCache._saveToStorage(); // Persist to localStorage
  },

  // Update location methods (for tracking where updates occur)
  setUpdateLocation: (artifactId: string, location: Omit<ArtifactUpdateLocation, 'timestamp'>) => {
    const locationData = {
      ...location,
      timestamp: Date.now(),
    };

    artifactCache._updateLocationCache.set(artifactId, locationData);
    artifactCache._saveToStorage(); // Persist to localStorage

    // Also sync to MongoDB for cross-device access
    artifactCache._syncToDatabase(artifactId, 'updateLocation', locationData);
  },

  getUpdateLocation: (artifactId: string): ArtifactUpdateLocation | null => {
    return artifactCache._updateLocationCache.get(artifactId) || null;
  },

  clearUpdateLocation: (artifactId: string) => {
    artifactCache._updateLocationCache.delete(artifactId);
    artifactCache._saveToStorage(); // Persist to localStorage
  },

  // Combined methods
  clear: (artifactId: string) => {
    artifactCache.clearSelection(artifactId);
    artifactCache.clearContent(artifactId);
    artifactCache.clearUpdateLocation(artifactId);
    // Note: _saveToStorage() is called by each clear method above
  },

  clearAll: () => {
    artifactCache._selectionCache.clear();
    artifactCache._contentCache.clear();
    artifactCache._updateLocationCache.clear();
    artifactCache._clearStorage(); // Clear from localStorage as well
  },

  // Initialization method - call this when the app starts
  init: () => {
    artifactCache._loadFromStorage();
  },

  // Enhanced initialization that also loads from database for a specific artifact
  initWithDatabase: async (artifactId: string) => {
    // Load from localStorage first for immediate access
    artifactCache._loadFromStorage();

    // Then load from database for the latest cross-device data
    await artifactCache._loadFromDatabase(artifactId);
  },

  // Load conversation cache from database
  loadConversationCache: async (conversationId: string) => {
    try {
      const entries = await artifactCacheApi.getConversationEntries(conversationId);

      for (const entry of entries) {
        switch (entry.cacheType) {
          case 'selection':
            artifactCache._selectionCache.set(
              entry.artifactId,
              entry.data as ArtifactSelectionContext,
            );
            break;
          case 'content':
            artifactCache._contentCache.set(entry.artifactId, entry.data as ArtifactContentCache);
            break;
          case 'updateLocation':
            artifactCache._updateLocationCache.set(
              entry.artifactId,
              entry.data as ArtifactUpdateLocation,
            );
            break;
        }
      }

      console.log('📥 [ArtifactCache] Loaded conversation cache from database:', {
        conversationId,
        entriesCount: entries.length,
      });

      // Save to localStorage for offline access
      artifactCache._saveToStorage();

      return entries;
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to load conversation cache:', error);
      return [];
    }
  },

  // Status and debugging
  getStatus: (artifactId: string): ArtifactCacheStatus => {
    const selection = artifactCache.getSelection(artifactId);
    const content = artifactCache.getContent(artifactId);

    return {
      hasSelection: !!selection,
      hasContent: !!content,
      selectionValid: artifactCache.isSelectionValid(artifactId),
      contentValid: artifactCache.isContentValid(artifactId),
      selection,
      content,
    };
  },

  // Legacy compatibility methods
  get: (artifactId: string) => artifactCache.getSelection(artifactId),
  set: (artifactId: string, context: Omit<ArtifactSelectionContext, 'timestamp'>) =>
    artifactCache.setSelection(artifactId, context),
  isValid: (artifactId: string, maxAge?: number) =>
    artifactCache.isSelectionValid(artifactId, maxAge),

  /**
   * Returns the correct display artifact for a given artifactId.
   * If a merged/cached version exists, returns that; otherwise, returns the base artifact.
   * Optionally, pass in the full _artifacts object for context (for merging updates).
   *
   * @param {string} artifactId
   * @param {object} [artifacts] - Optional, all artifacts keyed by id
   * @returns {object|undefined} - The display artifact (with merged content if available)
   */
  getDisplayArtifact: function (artifactId, artifacts) {
    // Try to get merged content from cache first
    const cached = artifactCache.getContent(artifactId);
    if (cached && cached.content) {
      // Return a pseudo-artifact with merged content
      return {
        ...(artifacts?.[artifactId] || {}),
        content: cached.content,
        isMerged: true,
      };
    }
    // Fallback: return the artifact from the provided artifacts object
    if (artifacts && artifacts[artifactId]) {
      return artifacts[artifactId];
    }
    return undefined;
  },
};

// For backward compatibility, export the legacy interface
export const artifactUpdateCache = artifactCache;
