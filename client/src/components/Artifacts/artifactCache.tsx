// Enhanced cache system for artifact updates
import { artifactCacheApi } from '~/routes/ArtifactCacheApi';
import { applyAllPartialUpdates } from '~/hooks/Artifacts/useArtifactUtlis';

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
  conversationId?: string;
  timestamp?: number;
  source?: 'user' | 'llm'; // NEW: Track if selection came from manual user ac
}

export interface ArtifactContentCache {
  content: string;
  title?: string;
  type?: string;
  identifier?: string;
  conversationId?: string;
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
  _databaseSyncTimers: new Map<string, NodeJS.Timeout>(),
  _saveToStorageTimer: null as NodeJS.Timeout | null, // Timer for debounced storage saves
  _isDirty: false, // Track if cache has unsaved changes

  // Storage limits (in bytes)
  _MAX_STORAGE_SIZE: 4 * 1024 * 1024, // 4MB limit (leaving headroom under 5MB quota)
  _MAX_CONTENT_ENTRIES: 50, // Maximum number of content entries to keep
  _MAX_SELECTION_AGE: 24 * 60 * 60 * 1000, // 24 hours for selections
  _MAX_CONTENT_AGE: 7 * 24 * 60 * 60 * 1000, // 7 days for content
  _STORAGE_SAVE_DEBOUNCE_MS: 2000, // Debounce localStorage saves by 2 seconds

  // Calculate size of data to be stored
  _calculateStorageSize: (data: any): number => {
    try {
      return new Blob([JSON.stringify(data)]).size;
    } catch {
      return JSON.stringify(data).length * 2; // Rough estimate (UTF-16)
    }
  },

  // Prune old entries to fit within storage limits
  _pruneOldEntries: () => {
    const now = Date.now();

    // 1. Remove old selections (older than 24 hours)
    console.log('🧹 [ArtifactCache] Pruning old selections...');
    let prunedSelections = 0;
    for (const [key, value] of artifactCache._selectionCache.entries()) {
      if (value.timestamp && now - value.timestamp > artifactCache._MAX_SELECTION_AGE) {
        artifactCache._selectionCache.delete(key);
        prunedSelections++;
      }
    }

    // 2. Remove old content entries (older than 7 days) or keep only the N most recent
    console.log('🧹 [ArtifactCache] Pruning old content entries...');
    const contentEntries = Array.from(artifactCache._contentCache.entries());
    let prunedContent = 0;

    // Remove old entries
    for (const [key, value] of contentEntries) {
      if (value.timestamp && now - value.timestamp > artifactCache._MAX_CONTENT_AGE) {
        artifactCache._contentCache.delete(key);
        prunedContent++;
      }
    }

    // If still too many entries, keep only the N most recent
    const remainingContent = Array.from(artifactCache._contentCache.entries());
    if (remainingContent.length > artifactCache._MAX_CONTENT_ENTRIES) {
      // Sort by timestamp (most recent first)
      remainingContent.sort((a, b) => b[1].timestamp - a[1].timestamp);

      // Remove oldest entries beyond the limit
      for (let i = artifactCache._MAX_CONTENT_ENTRIES; i < remainingContent.length; i++) {
        artifactCache._contentCache.delete(remainingContent[i][0]);
        prunedContent++;
      }
    }

    console.log('✅ [ArtifactCache] Pruning complete:', {
      prunedSelections,
      prunedContent,
      remainingSelections: artifactCache._selectionCache.size,
      remainingContent: artifactCache._contentCache.size,
    });

    return { prunedSelections, prunedContent };
  },

  // CRITICAL: Debounced version of _saveToStorage to prevent excessive writes
  // This batches rapid cache updates into a single localStorage write
  _debouncedSaveToStorage: () => {
    // Mark cache as dirty
    artifactCache._isDirty = true;

    // Clear existing timer
    if (artifactCache._saveToStorageTimer) {
      clearTimeout(artifactCache._saveToStorageTimer);
    }

    // Set new timer
    artifactCache._saveToStorageTimer = setTimeout(() => {
      if (artifactCache._isDirty) {
        console.log('💾 [ArtifactCache] Debounced save triggered');
        artifactCache._saveToStorageImmediate();
        artifactCache._isDirty = false;
      }
      artifactCache._saveToStorageTimer = null;
    }, artifactCache._STORAGE_SAVE_DEBOUNCE_MS);
  },

  // Immediate save (no debounce) - use sparingly
  _saveToStorageImmediate: () => {
    try {
      const selectionData = Array.from(artifactCache._selectionCache.entries());
      const contentData = Array.from(artifactCache._contentCache.entries());
      const updateLocationData = Array.from(artifactCache._updateLocationCache.entries());

      // Calculate total size
      const selectionSize = artifactCache._calculateStorageSize(selectionData);
      const contentSize = artifactCache._calculateStorageSize(contentData);
      const updateLocationSize = artifactCache._calculateStorageSize(updateLocationData);
      const totalSize = selectionSize + contentSize + updateLocationSize;

      // console.log('💾 [ArtifactCache] Saving to localStorage:', {
      //   selections: selectionData.length,
      //   content: contentData.length,
      //   updateLocations: updateLocationData.length,
      //   selectionSize: `${(selectionSize / 1024).toFixed(2)} KB`,
      //   contentSize: `${(contentSize / 1024).toFixed(2)} KB`,
      //   updateLocationSize: `${(updateLocationSize / 1024).toFixed(2)} KB`,
      //   totalSize: `${(totalSize / 1024).toFixed(2)} KB`,
      //   maxSize: `${(artifactCache._MAX_STORAGE_SIZE / 1024).toFixed(2)} KB`,
      //   utilizationPercent: `${((totalSize / artifactCache._MAX_STORAGE_SIZE) * 100).toFixed(1)}%`,
      // });

      // PROACTIVE PRUNING: Clean up BEFORE saving if we're using >60% of quota
      // This prevents quota exceeded errors before they happen
      const utilizationPercent = (totalSize / artifactCache._MAX_STORAGE_SIZE) * 100;
      if (utilizationPercent > 60) {
        console.warn(
          `⚠️ [ArtifactCache] Cache utilization is ${utilizationPercent.toFixed(1)}% (>60%), proactive pruning...`,
        );
        artifactCache._pruneOldEntries();

        // Recalculate after pruning
        const prunedSelectionData = Array.from(artifactCache._selectionCache.entries());
        const prunedContentData = Array.from(artifactCache._contentCache.entries());
        const prunedUpdateLocationData = Array.from(artifactCache._updateLocationCache.entries());

        const newTotalSize =
          artifactCache._calculateStorageSize(prunedSelectionData) +
          artifactCache._calculateStorageSize(prunedContentData) +
          artifactCache._calculateStorageSize(prunedUpdateLocationData);

        console.log('✅ [ArtifactCache] Proactive pruning complete:', {
          oldSize: `${(totalSize / 1024).toFixed(2)} KB`,
          newSize: `${(newTotalSize / 1024).toFixed(2)} KB`,
          saved: `${((totalSize - newTotalSize) / 1024).toFixed(2)} KB`,
          newUtilization: `${((newTotalSize / artifactCache._MAX_STORAGE_SIZE) * 100).toFixed(1)}%`,
        });

        // Use pruned data for saving
        localStorage.setItem('artifactCache_selections', JSON.stringify(prunedSelectionData));
        localStorage.setItem('artifactCache_content', JSON.stringify(prunedContentData));
        localStorage.setItem(
          'artifactCache_updateLocations',
          JSON.stringify(prunedUpdateLocationData),
        );
        console.log(
          '✅ [ArtifactCache] Successfully saved to localStorage (after proactive pruning)',
        );
        return;
      }

      // If size exceeds limit, prune old entries
      if (totalSize > artifactCache._MAX_STORAGE_SIZE) {
        console.warn('⚠️ [ArtifactCache] Storage size exceeds limit, pruning old entries...');
        artifactCache._pruneOldEntries();

        // Recalculate data after pruning
        const prunedSelectionData = Array.from(artifactCache._selectionCache.entries());
        const prunedContentData = Array.from(artifactCache._contentCache.entries());
        const prunedUpdateLocationData = Array.from(artifactCache._updateLocationCache.entries());

        const newTotalSize =
          artifactCache._calculateStorageSize(prunedSelectionData) +
          artifactCache._calculateStorageSize(prunedContentData) +
          artifactCache._calculateStorageSize(prunedUpdateLocationData);

        console.log('✅ [ArtifactCache] After pruning:', {
          oldSize: `${(totalSize / 1024).toFixed(2)} KB`,
          newSize: `${(newTotalSize / 1024).toFixed(2)} KB`,
          saved: `${((totalSize - newTotalSize) / 1024).toFixed(2)} KB`,
        });

        // Use pruned data for saving
        localStorage.setItem('artifactCache_selections', JSON.stringify(prunedSelectionData));
        localStorage.setItem('artifactCache_content', JSON.stringify(prunedContentData));
        localStorage.setItem(
          'artifactCache_updateLocations',
          JSON.stringify(prunedUpdateLocationData),
        );
      } else {
        // Save normally
        localStorage.setItem('artifactCache_selections', JSON.stringify(selectionData));
        localStorage.setItem('artifactCache_content', JSON.stringify(contentData));
        localStorage.setItem('artifactCache_updateLocations', JSON.stringify(updateLocationData));
      }

      console.log('✅ [ArtifactCache] Successfully saved to localStorage');
    } catch (error: any) {
      // Handle QuotaExceededError
      if (error?.name === 'QuotaExceededError' || error?.code === 22) {
        console.error(
          '❌ [ArtifactCache] QuotaExceededError - localStorage is full. Attempting emergency pruning...',
        );

        // Emergency pruning - remove more aggressively
        artifactCache._pruneOldEntries();

        // Try saving again with just selections and update locations (skip content)
        try {
          const selectionData = Array.from(artifactCache._selectionCache.entries());
          const updateLocationData = Array.from(artifactCache._updateLocationCache.entries());

          localStorage.setItem('artifactCache_selections', JSON.stringify(selectionData));
          localStorage.setItem('artifactCache_updateLocations', JSON.stringify(updateLocationData));

          // Clear content from localStorage (it's backed up in database anyway)
          localStorage.removeItem('artifactCache_content');

          console.warn(
            '⚠️ [ArtifactCache] Emergency save: Saved selections and locations only. Content will be loaded from database.',
          );
        } catch (retryError) {
          console.error('❌ [ArtifactCache] Emergency save also failed:', retryError);
        }
      } else {
        console.error('❌ [ArtifactCache] Failed to save to localStorage:', error);
      }
    }
  },

  // Default save method - uses debouncing to prevent excessive writes
  _saveToStorage: () => {
    artifactCache._debouncedSaveToStorage();
  },

  // Force immediate save (bypass debounce) - use only when necessary
  _flushStorageNow: () => {
    if (artifactCache._saveToStorageTimer) {
      clearTimeout(artifactCache._saveToStorageTimer);
      artifactCache._saveToStorageTimer = null;
    }
    if (artifactCache._isDirty) {
      artifactCache._saveToStorageImmediate();
      artifactCache._isDirty = false;
    }
  },

  _loadFromStorage: () => {
    try {
      const selectionData = localStorage.getItem('artifactCache_selections');
      const contentData = localStorage.getItem('artifactCache_content');
      const updateLocationData = localStorage.getItem('artifactCache_updateLocations');

      console.log('📂 [ArtifactCache] Loading from localStorage (RAW):', {
        selectionDataLength: selectionData?.length,
        contentDataLength: contentData?.length,
        updateLocationDataLength: updateLocationData?.length,
        selectionDataPreview: selectionData?.substring(0, 200),
      });

      if (selectionData) {
        const selections = JSON.parse(selectionData);
        artifactCache._selectionCache = new Map(selections);
        //   console.log('📍 [ArtifactCache] Loaded selection entries:', {
        //     count: selections.length,
        //     keys: selections.map(([key]: [string, any]) => key),
        //     details: selections.map(([key, val]: [string, ArtifactSelectionContext]) => ({
        //       key,
        //       startLine: val.startLine,
        //       endLine: val.endLine,
        //       artifactId: val.artifactId,
        //     })),
        //   });
      }

      if (contentData) {
        const content = JSON.parse(contentData);
        artifactCache._contentCache = new Map(content);
      }

      if (updateLocationData) {
        const updateLocations = JSON.parse(updateLocationData);
        artifactCache._updateLocationCache = new Map(updateLocations);
      }

      // console.log('📂 [ArtifactCache] Loaded from localStorage (SUMMARY):', {
      //   selections: artifactCache._selectionCache.size,
      //   content: artifactCache._contentCache.size,
      //   updateLocations: artifactCache._updateLocationCache.size,
      // });
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

      if (!result) {
        // Failed but that's ok - localStorage is working
        return null;
      }

      return result;
    } catch (_error) {
      // Silently fail - localStorage fallback is sufficient
      // Only log the first error to avoid console spam
      if (!(window as any)._artifactSyncWarningShown) {
        console.warn(
          '⚠️ [ArtifactCache] Database sync unavailable - artifacts will use localStorage only',
        );
        (window as any)._artifactSyncWarningShown = true;
      }
      return null;
    }
  },

  // Debounced database sync - prevents excessive writes during streaming
  _debouncedSyncToDatabase: (
    artifactId: string,
    cacheType: 'selection' | 'content' | 'updateLocation',
    data: any,
    options: { conversationId?: string; messageId?: string } = {},
    debounceMs: number = 1000,
  ) => {
    const key = `${artifactId}_${cacheType}`;

    // Clear existing timer for this artifact+cacheType
    const existingTimer = artifactCache._databaseSyncTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      artifactCache._syncToDatabase(artifactId, cacheType, data, options);
      artifactCache._databaseSyncTimers.delete(key);
    }, debounceMs);

    artifactCache._databaseSyncTimers.set(key, timer);
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
  setSelection: (
    artifactId: string,
    context: Omit<ArtifactSelectionContext, 'timestamp'>,
    options?: { conversationId?: string; messageId?: string },
  ) => {
    const selectionData = {
      ...context,
      conversationId: options?.conversationId, // Store for later use in flushPendingSyncs
      timestamp: Date.now(),
    };

    artifactCache._selectionCache.set(artifactId, selectionData);
    artifactCache._saveToStorage(); // Persist to localStorage

    artifactCache
      ._syncToDatabase(artifactId, 'selection', selectionData, {
        conversationId: options?.conversationId,
        messageId: options?.messageId || context.artifactMessageId,
      })
      .then((result) => {
        console.log('✅✅✅ [ArtifactCache.setSelection] _syncToDatabase COMPLETED:', {
          artifactId,
          success: !!result,
          result,
          savedConversationId: result?.conversationId,
        });
      })
      .catch((error) => {
        console.error('❌❌❌ [ArtifactCache.setSelection] _syncToDatabase FAILED:', error);
      });

    console.log('💾💾💾 [ArtifactCache.setSelection] ========== EXIT POINT ==========');
  },

  _normalizeArtifactId: (artifactId: string): string => {
    // Replace slashes with dashes to match new format
    return artifactId.replace(/\//g, '-');
  },

  getSelection: (artifactId: string): ArtifactSelectionContext | undefined => {
    // Try normalized ID first (new format)
    const normalizedId = artifactCache._normalizeArtifactId(artifactId);
    let selection = artifactCache._selectionCache.get(normalizedId);

    // Fallback: try original ID (for backward compatibility)
    if (!selection && normalizedId !== artifactId) {
      selection = artifactCache._selectionCache.get(artifactId);
    }

    return selection;
  },

  isSelectionValid: (artifactId: string, maxAge = 30000): boolean => {
    const normalizedId = artifactCache._normalizeArtifactId(artifactId);
    let entry = artifactCache._selectionCache.get(normalizedId);

    // Fallback: try original ID
    if (!entry && normalizedId !== artifactId) {
      entry = artifactCache._selectionCache.get(artifactId);
    }

    if (!entry) return false;
    return Date.now() - (entry.timestamp || 0) < maxAge;
  },

  clearSelection: (artifactId: string) => {
    const normalizedId = artifactCache._normalizeArtifactId(artifactId);

    // Clear both formats to be safe
    artifactCache._selectionCache.delete(normalizedId);
    if (normalizedId !== artifactId) {
      artifactCache._selectionCache.delete(artifactId);
    }

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
    if (artifactId.includes('_update')) {
      const baseIdentifier = artifactId.split('_update')[0];
      const updateIndexMatch = artifactId.match(/_update(\d+)_/);
      const currentUpdateIndex = updateIndexMatch ? parseInt(updateIndexMatch[1], 10) : -1;

      // Find ALL updates for this base identifier
      const allUpdates = Array.from(artifactCache._contentCache.entries()).filter(
        ([id, _data]) => id.startsWith(baseIdentifier) && id.includes('_update'),
      );

      let removedCount = 0;
      allUpdates.forEach(([oldId]) => {
        const oldIndexMatch = oldId.match(/_update(\d+)_/);
        const oldIndex = oldIndexMatch ? parseInt(oldIndexMatch[1], 10) : -1;

        // Remove if it's an older update OR a duplicate of the same update
        if (
          oldIndex < currentUpdateIndex ||
          (oldIndex === currentUpdateIndex && oldId !== artifactId)
        ) {
          console.log(`  🗑️ Removing old update: ${oldId} (index ${oldIndex})`);
          artifactCache._contentCache.delete(oldId);
          removedCount++;
        }
      });

      if (removedCount > 0) {
        console.log(`✅ [setContent] Removed ${removedCount} old update(s) to free space`);
      }
    }

    const contentData = {
      content,
      timestamp: Date.now(),
      source: 'directive' as const,
      creationTime: existing?.creationTime || Date.now(),
      ...metadata,
    };

    artifactCache._contentCache.set(artifactId, contentData);
    artifactCache._saveToStorage(); // Persist to localStorage
    const isUpdateArtifact = artifactId.includes('_update');

    if (isUpdateArtifact) {
      console.log('🚀 [setContent] UPDATE artifact detected - syncing IMMEDIATELY (no debounce):', {
        artifactId,
        contentLength: content.length,
        conversationId: metadata.conversationId,
      });

      // Immediate sync for update artifacts
      artifactCache
        ._syncToDatabase(artifactId, 'content', contentData, {
          conversationId: metadata.conversationId || undefined,
        })
        .then((result) => {
          console.log('✅✅✅ [setContent] UPDATE artifact sync completed:', {
            artifactId,
            success: !!result,
            savedConversationId: result?.conversationId,
          });
        })
        .catch((error) => {
          console.error('❌❌❌ [setContent] UPDATE artifact sync FAILED:', error);
        });
    } else {
      console.log('⏱️ [setContent] BASE artifact - using debounced sync:', {
        artifactId,
        debounceMs: 1000,
      });

      artifactCache._debouncedSyncToDatabase(artifactId, 'content', contentData, {
        conversationId: metadata.conversationId || undefined,
      });
    }
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

    // Use DEBOUNCED sync to database to prevent excessive writes
    artifactCache._debouncedSyncToDatabase(artifactId, 'updateLocation', locationData);
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

    // Clear all pending database sync timers
    for (const timer of artifactCache._databaseSyncTimers.values()) {
      clearTimeout(timer);
    }
    artifactCache._databaseSyncTimers.clear();
  },

  // Flush all pending database syncs immediately
  flushPendingSyncs: async () => {
    const promises: Promise<any>[] = [];
    for (const [artifactId, selectionData] of artifactCache._selectionCache.entries()) {
      promises.push(
        artifactCache._syncToDatabase(artifactId, 'selection', selectionData, {
          conversationId: selectionData.conversationId, // FIXED: Use conversationId, not artifactMessageId
          messageId: selectionData.artifactMessageId,
        }),
      );
    }

    // Get all pending syncs and execute them immediately
    for (const [key, timer] of artifactCache._databaseSyncTimers.entries()) {
      clearTimeout(timer);

      // Parse the key to get artifactId and cacheType
      const lastUnderscore = key.lastIndexOf('_');
      const artifactId = key.substring(0, lastUnderscore);
      const cacheType = key.substring(lastUnderscore + 1) as
        | 'selection'
        | 'content'
        | 'updateLocation';

      // Get the data from cache
      let data: any;
      let options: any = {};

      switch (cacheType) {
        case 'selection':
          data = artifactCache._selectionCache.get(artifactId);
          if (data) {
            options = {
              conversationId: data.conversationId, // FIXED: Use conversationId from data
              messageId: data.artifactMessageId,
            };
          }
          break;
        case 'content':
          data = artifactCache._contentCache.get(artifactId);
          if (data) {
            options = { conversationId: data.conversationId }; // FIXED: Use conversationId, not identifier
          }
          break;
        case 'updateLocation':
          data = artifactCache._updateLocationCache.get(artifactId);
          break;
      }

      if (data) {
        promises.push(artifactCache._syncToDatabase(artifactId, cacheType, data, options));
      }
    }

    artifactCache._databaseSyncTimers.clear();

    await Promise.all(promises);
    // console.log(
    //   '✅ [ArtifactCache.flushPendingSyncs] Flushed all pending database syncs:',
    //   promises.length,
    // );

    // CRITICAL: Also flush localStorage immediately (bypass debounce)
    artifactCache._flushStorageNow();
    //console.log('✅ [ArtifactCache.flushPendingSyncs] Also flushed localStorage');
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
      console.log(
        '🌐 [ArtifactCache] Fetching conversation entries from database for:',
        conversationId,
      );
      const entries = await artifactCacheApi.getConversationEntries(conversationId);

      for (const entry of entries) {
        switch (entry.cacheType) {
          case 'selection': {
            const existingSelection = artifactCache._selectionCache.get(entry.artifactId);
            if (!existingSelection) {
              artifactCache._selectionCache.set(
                entry.artifactId,
                entry.data as ArtifactSelectionContext,
              );
              console.log('✅ [ArtifactCache] Selection cached (NEWEST)');
            } else {
              // console.log(
              //   '⏭️ [ArtifactCache] Skipping OLDER selection entry - already have newer version for:',
              //   entry.artifactId,
              // );
            }
            break;
          }
          case 'content': {
            console.log('💾💾💾 [ArtifactCache] Loading CONTENT entry to cache:', {
              artifactId: entry.artifactId,
              contentLength: (entry.data as ArtifactContentCache).content?.length || 0,
              contentPreview:
                (entry.data as ArtifactContentCache).content?.substring(0, 200) || 'NO CONTENT',
              timestamp: (entry.data as ArtifactContentCache).timestamp,
              source: (entry.data as ArtifactContentCache).source,
            });

            const existingContent = artifactCache._contentCache.get(entry.artifactId);
            if (!existingContent) {
              artifactCache._contentCache.set(entry.artifactId, entry.data as ArtifactContentCache);
              console.log(
                '✅ [ArtifactCache] Content cached (NEWEST). Current content cache size:',
                artifactCache._contentCache.size,
              );
            } else {
              console.log(
                '⏭️ [ArtifactCache] Skipping OLDER content entry - already have newer version for:',
                entry.artifactId,
                entry.data,
                {
                  existingTimestamp: existingContent.timestamp,
                  thisTimestamp: (entry.data as ArtifactContentCache).timestamp,
                  existingIsNewer:
                    (existingContent.timestamp || 0) >
                    ((entry.data as ArtifactContentCache).timestamp || 0),
                },
              );
            }
            break;
          }
          case 'updateLocation':
            artifactCache._updateLocationCache.set(
              entry.artifactId,
              entry.data as ArtifactUpdateLocation,
            );
            break;
        }
      }
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
   * If a merged/cached version exists, returns that; otherwise, computes merge on-the-fly.
   * Optionally, pass in the full _artifacts object for context (for merging updates).
   *
   * @param {string} artifactId
   * @param {object} [artifacts] - Optional, all artifacts keyed by id
   * @returns {object|undefined} - The display artifact (with merged content if available)
   */
  getDisplayArtifact: function (artifactId: string, artifacts?: Record<string, any>) {
    if (!artifacts || !artifacts[artifactId]) {
      console.warn('⚠️ [getDisplayArtifact] Artifact not found in artifacts object:', artifactId);
      return undefined;
    }

    const artifact = artifacts[artifactId];
    const isActuallyUpdate = artifactId.includes('_update');

    if (artifact.isUpdate && !isActuallyUpdate) {
      console.warn('⚠️ [getDisplayArtifact] FIXING incorrect isUpdate flag for base artifact:', {
        artifactId,
        wasMarkedAsUpdate: true,
        shouldBeUpdate: false,
        FIXING: 'Treating as base artifact',
      });
      // Don't modify the original artifact, just skip the update logic
    }
    const isRecentlyUpdated =
      artifact.lastUpdateTime && Date.now() - artifact.lastUpdateTime < 5000;

    if (isActuallyUpdate && artifact.isMerged && artifact.content && isRecentlyUpdated) {
      console.log(
        '✅ [getDisplayArtifact] Update artifact ALREADY merged with FRESH content, returning as-is:',
        artifactId,
        {
          contentLength: artifact.content?.length,
          isMerged: true,
          age: Date.now() - (artifact.lastUpdateTime || 0),
          SKIPPING_CACHE_AND_MERGE: 'Fresh merged content takes priority',
        },
      );
      return artifact;
    }

    if (isActuallyUpdate) {
      const cached = artifactCache.getContent(artifactId);
      const selection = artifactCache.getSelection(artifactId);

      // Check if selection is NEWER than cached content (indicates pending merge needed)
      const hasNewerSelection =
        selection && cached && (selection.timestamp || 0) > (cached.timestamp || 0);

      if (cached && cached.content && cached.content.trim() !== '' && !hasNewerSelection) {
        return {
          ...artifact,
          content: cached.content,
          isMerged: true,
        };
      }
    }

    if (isActuallyUpdate) {
      const baseArtifact = Object.values(artifacts).find(
        (a) => a && !a.isUpdate && a.identifier === artifact.identifier,
      );

      if (baseArtifact) {
        const mergedContent = applyAllPartialUpdates(
          baseArtifact.content,
          artifacts,
          artifactId,
          false,
          null,
        );

        return {
          ...artifact,
          content: mergedContent,
          isMerged: true,
        };
      }
    }

    // PRIORITY 4: Check cache for base artifacts
    const cached = artifactCache.getContent(artifactId);
    if (cached && cached.content) {
      return {
        ...artifact,
        content: cached.content,
        isMerged: true,
      };
    }

    // PRIORITY 4: Fallback - return artifact as-is
    console.log('📄 [getDisplayArtifact] Returning artifact as-is:', artifactId);
    return artifact;
  },

  // Utility methods for manual cache management

  /**
   * Get current storage statistics
   * @returns Object with size information and recommendations
   */
  getStorageStats: () => {
    const selectionData = Array.from(artifactCache._selectionCache.entries());
    const contentData = Array.from(artifactCache._contentCache.entries());
    const updateLocationData = Array.from(artifactCache._updateLocationCache.entries());

    const selectionSize = artifactCache._calculateStorageSize(selectionData);
    const contentSize = artifactCache._calculateStorageSize(contentData);
    const updateLocationSize = artifactCache._calculateStorageSize(updateLocationData);
    const totalSize = selectionSize + contentSize + updateLocationSize;

    const stats = {
      entries: {
        selections: selectionData.length,
        content: contentData.length,
        updateLocations: updateLocationData.length,
      },
      sizes: {
        selections: selectionSize,
        content: contentSize,
        updateLocations: updateLocationSize,
        total: totalSize,
        max: artifactCache._MAX_STORAGE_SIZE,
      },
      formatted: {
        selections: `${(selectionSize / 1024).toFixed(2)} KB`,
        content: `${(contentSize / 1024).toFixed(2)} KB`,
        updateLocations: `${(updateLocationSize / 1024).toFixed(2)} KB`,
        total: `${(totalSize / 1024).toFixed(2)} KB`,
        max: `${(artifactCache._MAX_STORAGE_SIZE / 1024).toFixed(2)} KB`,
      },
      utilization: {
        percent: ((totalSize / artifactCache._MAX_STORAGE_SIZE) * 100).toFixed(1),
        isNearLimit: totalSize > artifactCache._MAX_STORAGE_SIZE * 0.8, // >80%
        isOverLimit: totalSize > artifactCache._MAX_STORAGE_SIZE,
      },
      recommendations: [] as string[],
    };

    // Add recommendations
    if (stats.utilization.isOverLimit) {
      stats.recommendations.push('⚠️ Cache is over limit! Run pruneCache() immediately.');
    } else if (stats.utilization.isNearLimit) {
      stats.recommendations.push('⚠️ Cache is near limit (>80%). Consider running pruneCache().');
    } else {
      stats.recommendations.push('✅ Cache size is healthy.');
    }

    if (contentData.length > artifactCache._MAX_CONTENT_ENTRIES) {
      stats.recommendations.push(
        `⚠️ Too many content entries (${contentData.length}/${artifactCache._MAX_CONTENT_ENTRIES}). Run pruneCache().`,
      );
    }

    return stats;
  },

  /**
   * Manually trigger cache pruning
   * @returns Pruning results
   */
  pruneCache: () => {
    console.log('🧹 [ArtifactCache.pruneCache] Manual cache pruning triggered...');
    const result = artifactCache._pruneOldEntries();
    artifactCache._saveToStorage();
    console.log('✅ [ArtifactCache.pruneCache] Cache pruning complete:', result);
    return result;
  },

  /**
   * Get detailed breakdown of cache contents
   * @returns Detailed cache information
   */
  getCacheBreakdown: () => {
    const now = Date.now();

    const selections = Array.from(artifactCache._selectionCache.entries()).map(([id, data]) => ({
      id,
      age: data.timestamp ? now - data.timestamp : null,
      ageFormatted: data.timestamp
        ? `${Math.floor((now - data.timestamp) / 1000 / 60)} mins`
        : 'unknown',
      size: artifactCache._calculateStorageSize(data),
    }));

    const content = Array.from(artifactCache._contentCache.entries()).map(([id, data]) => ({
      id,
      age: now - data.timestamp,
      ageFormatted: `${Math.floor((now - data.timestamp) / 1000 / 60)} mins`,
      size: artifactCache._calculateStorageSize(data),
      contentLength: data.content?.length || 0,
      source: data.source,
    }));

    return {
      selections,
      content,
      totals: {
        selectionsSize: selections.reduce((sum, s) => sum + s.size, 0),
        contentSize: content.reduce((sum, c) => sum + c.size, 0),
      },
    };
  },
};

// For backward compatibility, export the legacy interface
export const artifactUpdateCache = artifactCache;
