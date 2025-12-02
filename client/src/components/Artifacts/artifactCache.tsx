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

  // Persistence helper methods
  _saveToStorage: () => {
    try {
      const selectionData = Array.from(artifactCache._selectionCache.entries());
      const contentData = Array.from(artifactCache._contentCache.entries());
      const updateLocationData = Array.from(artifactCache._updateLocationCache.entries());

      // console.log('💾 [ArtifactCache] Saving to localStorage (DETAILS):', {
      //   selections: selectionData.length,
      //   content: contentData.length,
      //   updateLocations: updateLocationData.length,
      //   selectionKeys: selectionData.map(([key]) => key),
      //   selectionDetails: selectionData.map(([key, val]) => ({
      //     key,
      //     artifactId: val.artifactId,
      //     startLine: val.startLine,
      //     endLine: val.endLine,
      //     originalTextPreview: val.originalText?.substring(0, 50),
      //   })),
      // });

      localStorage.setItem('artifactCache_selections', JSON.stringify(selectionData));
      localStorage.setItem('artifactCache_content', JSON.stringify(contentData));
      localStorage.setItem('artifactCache_updateLocations', JSON.stringify(updateLocationData));

      // console.log('✅ [ArtifactCache] Successfully saved to localStorage');
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to save to localStorage:', error);
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

      // console.log('✅✅✅ [ArtifactCache._syncToDatabase] Database sync COMPLETED:', {
      //   artifactId,
      //   cacheType,
      //   success: !!result,
      //   conversationId: options.conversationId,
      //   savedConversationId: result?.conversationId,
      //   resultPreview: result ? JSON.stringify(result).substring(0, 200) : 'null',
      // });

      return result;
    } catch (error) {
      console.error('❌ [ArtifactCache] Failed to sync to database:', error);
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

    console.log('💾 [ArtifactCache.setSelection] Saving selection context:', {
      artifactId,
      conversationId: options?.conversationId,
      messageId: options?.messageId || context.artifactMessageId,
      startLine: selectionData.startLine,
      endLine: selectionData.endLine,
      startColumn: selectionData.startColumn,
      endColumn: selectionData.endColumn,
      originalTextPreview: selectionData.originalText?.substring(0, 50),
      updatedTextPreview: selectionData.updatedText?.substring(0, 50),
      WILL_CALL_SYNC_TO_DATABASE: true,
      STORED_CONVERSATION_ID: selectionData.conversationId, // Verify it's stored
    });

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

    // CRITICAL: Prevent overwriting full merged content with smaller snippet/delta
    // Only save if the new content is LONGER than existing content
    // This prevents snippets from overwriting full merged documents
    if (existing && existing.content && existing.content.length > content.length) {
      console.warn('⚠️ [setContent] SKIPPING save - new content is SMALLER than existing:', {
        artifactId,
        existingLength: existing.content.length,
        newLength: content.length,
        difference: existing.content.length - content.length,
        existingPreview: existing.content.substring(0, 100),
        newPreview: content.substring(0, 100),
        REASON: 'Preventing snippet from overwriting full merged content',
      });
      return; // Don't overwrite full content with smaller snippet
    }

    // CRITICAL: For update artifacts, check if there's already a similar update with the same index
    // This prevents duplicate update0, update1, etc. from being created when messageId changes
    if (artifactId.includes('_update')) {
      // Extract the base identifier and update index from the artifactId
      const updateIndexMatch = artifactId.match(/_update(\d+)_/);
      if (updateIndexMatch) {
        const updateIndex = updateIndexMatch[1];
        const baseIdentifier = artifactId.split('_update')[0];

        // Find all cached updates with the same base identifier and update index
        const similarUpdates = Array.from(artifactCache._contentCache.entries()).filter(
          ([id, _data]) => {
            return id.startsWith(baseIdentifier) && id.includes(`_update${updateIndex}_`);
          },
        );

        console.log('🔍 [setContent] Checking for duplicate update artifacts:', {
          artifactId,
          baseIdentifier,
          updateIndex,
          similarUpdatesCount: similarUpdates.length,
          similarUpdateIds: similarUpdates.map(([id]) => id),
        });

        // If we found a similar update, keep the one with the most recent content
        if (similarUpdates.length > 0) {
          const [existingId, existingData] = similarUpdates[0]; // Use first one found

          // Compare timestamps - keep the newer one
          if (existingData.timestamp && existingData.timestamp > Date.now() - 5000) {
            // Existing was saved within last 5 seconds - probably same edit session
            console.warn('⚠️ [setContent] REPLACING duplicate update artifact:', {
              oldId: existingId,
              newId: artifactId,
              oldTimestamp: existingData.timestamp,
              newTimestamp: Date.now(),
              timeDiff: Date.now() - existingData.timestamp,
            });

            // Remove the old duplicate from cache
            artifactCache._contentCache.delete(existingId);

            // Also delete from database
            artifactCache._deleteFromDatabase(existingId, 'content');
          }
        }
      }
    }

    const contentData = {
      content,
      timestamp: Date.now(),
      source: 'directive' as const,
      creationTime: existing?.creationTime || Date.now(),
      ...metadata,
    };

    console.log('💾 [setContent] Saving content to cache:', {
      artifactId,
      contentLength: content.length,
      contentPreview: content.substring(0, 200),
      metadata,
      cacheSize: artifactCache._contentCache.size,
      isUpdate: !!existing,
      previousLength: existing?.content?.length || 0,
    });

    artifactCache._contentCache.set(artifactId, contentData);
    artifactCache._saveToStorage(); // Persist to localStorage

    console.log('✅ [setContent] Content saved. New cache size:', artifactCache._contentCache.size);

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

    // CRITICAL: Also sync all current cache entries immediately
    // This ensures selections made right before refresh are saved
    console.log(
      '💾 [ArtifactCache.flushPendingSyncs] Syncing ALL current selections to database...',
    );
    for (const [artifactId, selectionData] of artifactCache._selectionCache.entries()) {
      console.log('📤 [flushPendingSyncs] Syncing selection for:', artifactId, {
        conversationId: selectionData.conversationId, // Use stored conversationId (CORRECT)
        artifactMessageId: selectionData.artifactMessageId,
        BUG_FIX: 'Using selectionData.conversationId instead of selectionData.artifactMessageId',
      });
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
    console.log(
      '✅ [ArtifactCache.flushPendingSyncs] Flushed all pending database syncs:',
      promises.length,
    );
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

      // CRITICAL: Log what's currently in cache BEFORE loading from database
      console.log('📦 [ArtifactCache] Content cache state BEFORE database load:', {
        contentCacheSize: artifactCache._contentCache.size,
        contentCacheKeys: Array.from(artifactCache._contentCache.keys()),
        contentCachePreviews: Array.from(artifactCache._contentCache.entries()).map(
          ([id, content]) => ({
            artifactId: id,
            contentLength: content.content?.length || 0,
            source: content.source,
            timestamp: content.timestamp,
          }),
        ),
      });

      const entries = await artifactCacheApi.getConversationEntries(conversationId);

      // console.log('📥 [ArtifactCache] Received entries from database:', {
      //   conversationId,
      //   entriesCount: entries.length,
      //   entryTypes: entries.map((e) => e.cacheType),
      //   entryArtifactIds: entries.map((e) => e.artifactId),
      //   contentEntries: entries
      //     .filter((e) => e.cacheType === 'content')
      //     .map((e) => ({
      //       artifactId: e.artifactId,
      //       contentLength: (e.data as ArtifactContentCache).content?.length || 0,
      //       contentPreview: (e.data as ArtifactContentCache).content?.substring(0, 100),
      //     })),
      //   selectionEntries: entries
      //     .filter((e) => e.cacheType === 'selection')
      //     .map((e) => ({
      //     artifactId: e.artifactId,
      //     data: e.data,
      //   })),
      // });

      for (const entry of entries) {
        switch (entry.cacheType) {
          case 'selection': {
            console.log('💾 [ArtifactCache] Loading selection entry to cache:', {
              artifactId: entry.artifactId,
              startLine: (entry.data as ArtifactSelectionContext).startLine,
              endLine: (entry.data as ArtifactSelectionContext).endLine,
            });

            const existingSelection = artifactCache._selectionCache.get(entry.artifactId);
            if (!existingSelection) {
            artifactCache._selectionCache.set(
              entry.artifactId,
              entry.data as ArtifactSelectionContext,
            );
              console.log('✅ [ArtifactCache] Selection cached (NEWEST)');
            } else {
              console.log(
                '⏭️ [ArtifactCache] Skipping OLDER selection entry - already have newer version for:',
                entry.artifactId,
              );
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

            // CRITICAL: Only set if this artifact ID doesn't already have content
            // Database returns entries sorted by updatedAt DESC (newest first)
            // So the first content entry we see is the most recent one - keep it!
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

      // Dump ALL selection coordinates for debugging
      console.log('🔍 [ArtifactCache] COMPLETE SELECTION CACHE DUMP:');
      console.log('═'.repeat(80));
      const allSelections = Array.from(artifactCache._selectionCache.entries());
      allSelections.forEach(([artifactId, selection], idx) => {
        // console.log(`\n📍 Selection ${idx + 1}/${allSelections.length}:`);
        // console.log(`   Artifact ID: ${artifactId}`);
        // console.log(`   File Key: ${selection.fileKey}`);
        // console.log(`   Start Line: ${selection.startLine} (0-based)`);
        // console.log(`   End Line: ${selection.endLine} (0-based)`);
        // console.log(`   Start Column: ${selection.startColumn}`);
        // console.log(`   End Column: ${selection.endColumn}`);
        // console.log(
        //   `   Original Text: "${selection.originalText?.substring(0, 100)}${selection.originalText && selection.originalText.length > 100 ? '...' : ''}"`,
        // );
        // console.log(
        //   `   Updated Text: "${selection.updatedText?.substring(0, 100)}${selection.updatedText && selection.updatedText.length > 100 ? '...' : ''}"`,
        // );
        // console.log(`   Artifact Index: ${selection.artifactIndex ?? 'undefined'}`);
        // console.log(`   Message ID: ${selection.artifactMessageId || 'undefined'}`);
        // console.log(`   Timestamp: ${selection.timestamp || 'undefined'}`);
      });
      // console.log('═'.repeat(80));

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

    console.log('🔍 [getDisplayArtifact] Artifact details:', {
      artifactId,
      isUpdate: artifact.isUpdate,
      isMerged: artifact.isMerged,
      hasContent: !!artifact.content,
      contentLength: artifact.content?.length,
      identifier: artifact.identifier,
      artifactIdContainsUpdate: artifactId.includes('_update'),
    });
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
          SKIPPING_MERGE: 'Fresh merged content takes priority',
        },
      );
      return artifact;
    }

    if (isActuallyUpdate) {
      if (artifact.isMerged && artifact.content) {
        // Silently return - already merged
        return artifact;
      }
      console.log(
        '🔄 [getDisplayArtifact] Update artifact needs merge (page refresh or stale), computing for:',
        artifactId,
        {
          hasIsMergedFlag: artifact.isMerged,
          isRecentlyUpdated,
          age: artifact.lastUpdateTime ? Date.now() - artifact.lastUpdateTime : 'unknown',
          REASON: isRecentlyUpdated
            ? 'Recent but not marked as merged'
            : 'Stale or page refresh - recomputing merge',
        },
      );

      const baseArtifact = Object.values(artifacts).find(
        (a) => a && !a.isUpdate && a.identifier === artifact.identifier,
      );

      if (baseArtifact) {
        // console.log(
        //   '🔴 [ArtifactCache.getDisplayArtifact] Computing merged content on page refresh:',
        //   {
        //     location: 'ArtifactCache.ts getDisplayArtifact()',
        //     reason: 'Page refresh - recomputing merge',
        //     baseArtifactId: baseArtifact.id,
        //     targetArtifactId: artifactId,
        //     baseContentLength: baseArtifact.content?.length,
        //   },
        // );

        const mergedContent = applyAllPartialUpdates(
          baseArtifact.content,
          artifacts,
          artifactId,
          false,
          null,
        );

        console.log('✅ [getDisplayArtifact] Recomputed merged content:', {
          artifactId,
          originalLength: baseArtifact.content?.length,
          mergedLength: mergedContent?.length,
        });

        return {
          ...artifact,
          content: mergedContent,
          isMerged: true,
        };
      }
    }

    // PRIORITY 3: Check cache (only for base artifacts or if merge failed)
    const cached = artifactCache.getContent(artifactId);
    if (cached && cached.content) {
      console.log(
        '📦 [getDisplayArtifact] Returning cached content for base artifact:',
        artifactId,
      );
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
};

// For backward compatibility, export the legacy interface
export const artifactUpdateCache = artifactCache;
