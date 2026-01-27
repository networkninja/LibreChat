import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Constants } from 'librechat-data-provider';
import { useRecoilState, useResetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import { useRecoilState, useResetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import { useArtifactsContext } from '~/Providers';
import { logger } from '~/utils';
import store from '~/store';
import { artifactCache } from '~/components/Artifacts/artifactCache';
import {
  saveConversationIdToStorage,
  loadConversationIdFromStorage,
  saveArtifactsToStorage,
  loadArtifactsFromStorage,
  artifactRefreshTriggerState, // Import from store instead of creating here
} from '~/store/artifacts';

export default function useArtifacts() {
  const [activeTab, setActiveTab] = useState('preview');
  const location = useLocation();
  const artifactsContext = useArtifactsContext();

  // Get conversationId from context with URL fallback
  const conversationId =
    artifactsContext.conversationId || location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;
  const { isSubmitting, latestMessageId, latestMessageText } = useArtifactsContext();

  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const resetArtifactsVisibility = useResetRecoilState(store.artifactsVisibility);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);
  const resetArtifactsVisibility = useResetRecoilState(store.artifactsVisibility);
  const resetVisibleArtifacts = useResetRecoilState(store.visibleArtifacts);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const [_refreshTrigger, setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // CRITICAL: Initialize cache FIRST before loading artifacts
  // This ensures selection contexts are available when artifacts are merged
  useEffect(() => {
    const loadCache = async () => {
      artifactCache.init();

      // Load conversation cache from database on page refresh
      if (conversationId && conversationId !== Constants.NEW_CONVO) {
        console.log(
          '🔄 [useArtifacts] Loading conversation cache from database for:',
          conversationId,
        );
        try {
          await artifactCache.loadConversationCache(conversationId);
          console.log(
            '✅ [useArtifacts] Cache loaded successfully - selection cache size:',
            artifactCache._selectionCache.size,
          );
          setCacheLoaded(true);
        } catch (error) {
          console.error('Failed to load conversation cache from database:', error);
          setCacheLoaded(true); // Set to true even on error to unblock UI
        }
      } else {
        console.log('✅ [useArtifacts] No conversation to load - cache ready');
        setCacheLoaded(true); // No conversation to load, mark as ready
      }
    };

    loadCache();
  }, [conversationId, artifactsContext.conversationId, location.pathname]); // CRITICAL: Hydrate artifacts with cached content on initial load/refresh
  // WAIT for cache to load before hydrating artifacts!
  useEffect(() => {
    if (!artifacts || Object.keys(artifacts).length === 0) {
      return;
    }

    // CRITICAL: Wait for cache to be loaded before hydrating
    if (!cacheLoaded) {
      console.log('⏳ [useArtifacts] Waiting for cache to load before hydrating artifacts');
      return;
    }

    console.log(
      '🔄 [useArtifacts] Checking for cached content to hydrate artifacts (cache is loaded)',
    );
    // Check if any artifact has cached content that should be applied
    let hasUpdates = false;
    const updatedArtifacts = { ...artifacts };

    Object.keys(artifacts).forEach((artifactId) => {
      const artifact = artifacts[artifactId];
      if (!artifact) return;
      if (artifact.isUpdate) {
        console.log('⏭️ Skipping cache hydration for update artifact:', artifactId);
        return;
      }

      const cachedContent = artifactCache.getContent(artifactId);
      console.log('Checking artifact for cache hydration:', {
        artifactId,
        artifact,
        cachedContent,
      });

      if (cachedContent && cachedContent.content !== artifact.content) {
        console.log('💾 [useArtifacts] Hydrating BASE artifact from cache:', {
          artifactId,
          isUpdate: artifact.isUpdate,
          cachedLength: cachedContent.content.length,
          currentLength: artifact.content?.length,
        });

        updatedArtifacts[artifactId] = {
          ...artifact,
          id: artifact.id || artifactId,
          content: cachedContent.content,
        };
        hasUpdates = true;
      }
    });

    if (hasUpdates) {
      console.log('✅ [useArtifacts] Applying cached content to artifacts');
      setArtifacts(updatedArtifacts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, cacheLoaded]); // CRITICAL: Also depend on cacheLoaded!

  const orderedArtifactIds = useMemo(() => {
    console.log('artifacts in order', artifacts);
    // Show all artifacts for now - no filtering
    console.log('artifacts in order', artifacts);
    // Show all artifacts for now - no filtering
    return Object.keys(artifacts ?? {}).sort(
      (a, b) => (artifacts?.[a]?.lastUpdateTime ?? 0) - (artifacts?.[b]?.lastUpdateTime ?? 0),
    );
  }, [artifacts]);

  const prevIsSubmittingRef = useRef<boolean>(false);
  const prevIsSubmittingRef = useRef<boolean>(false);
  const lastContentRef = useRef<string | null>(null);
  const hasEnclosedArtifactRef = useRef<boolean>(false);
  const hasAutoSwitchedToCodeRef = useRef<boolean>(false);
  const lastRunMessageIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | null>(null);
  const pendingArtifactUpdateRef = useRef<boolean>(false);
  const refreshedArtifactsRef = useRef<Set<string>>(new Set());
  const pendingArtifactUpdateRef = useRef<boolean>(false);
  const refreshedArtifactsRef = useRef<Set<string>>(new Set());

  // Reset artifacts and cache when conversation changes
  // Reset artifacts and cache when conversation changes
  useEffect(() => {
    const resetState = () => {
      resetArtifacts();
      resetCurrentArtifactId();
      resetArtifactsVisibility();
      resetVisibleArtifacts();
      resetArtifactsVisibility();
      resetVisibleArtifacts();
      prevConversationIdRef.current = conversationId;
      lastRunMessageIdRef.current = null;
      lastContentRef.current = null;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
      pendingArtifactUpdateRef.current = false;
      refreshedArtifactsRef.current.clear(); // Clear refresh tracking on conversation change

      // Clear the artifact cache as well (but keep database sync)
      // Don't clear cache completely on refresh - only on actual conversation changes
      if (isConversationChange) {
        artifactCache.clearAll();
        console.log('Cleared all artifact caches on conversation change');
      } else {
        console.log('Page refresh detected - preserving artifact cache');
      }
    };

    // Get the previously stored conversation ID
    const storedConversationId = loadConversationIdFromStorage();

    // Check if this is a genuine conversation change (not a page refresh)
    const isConversationChange =
      conversationId !== storedConversationId &&
      storedConversationId != null &&
      conversationId !== null;

    if (isConversationChange && conversationId !== Constants.NEW_CONVO) {
      console.log('Conversation changed, saving current artifacts and loading new ones:', {
        from: storedConversationId,
        to: conversationId,
      });

      // Save current artifacts for the old conversation
      if (storedConversationId && artifacts) {
        saveArtifactsToStorage(artifacts, storedConversationId);
      }

      // Load artifacts for the new conversation
      const newArtifacts = loadArtifactsFromStorage(conversationId);
      if (newArtifacts) {
        setArtifacts(newArtifacts);
        console.log(
          'Loaded artifacts for conversation:',
          conversationId,
          Object.keys(newArtifacts),
        );
      } else {
        resetState();
      }
      hasAutoSwitchedToCodeRef.current = false;
      pendingArtifactUpdateRef.current = false;
      refreshedArtifactsRef.current.clear(); // Clear refresh tracking on conversation change

      // Clear the artifact cache as well (but keep database sync)
      // Don't clear cache completely on refresh - only on actual conversation changes
      if (isConversationChange) {
        artifactCache.clearAll();
        console.log('Cleared all artifact caches on conversation change');
      } else {
        console.log('Page refresh detected - preserving artifact cache');
      }
    };

    // Get the previously stored conversation ID
    const storedConversationId = loadConversationIdFromStorage();

    // Check if this is a genuine conversation change (not a page refresh)
    const isConversationChange =
      conversationId !== storedConversationId &&
      storedConversationId != null &&
      conversationId !== null;

    if (isConversationChange && conversationId !== Constants.NEW_CONVO) {
      console.log('Conversation changed, saving current artifacts and loading new ones:', {
        from: storedConversationId,
        to: conversationId,
      });

      // Save current artifacts for the old conversation
      if (storedConversationId && artifacts) {
        saveArtifactsToStorage(artifacts, storedConversationId);
      }

      // Load artifacts for the new conversation
      const newArtifacts = loadArtifactsFromStorage(conversationId);
      if (newArtifacts) {
        setArtifacts(newArtifacts);
        console.log(
          'Loaded artifacts for conversation:',
          conversationId,
          Object.keys(newArtifacts),
        );
      } else {
        resetState();
      }
    } else if (conversationId === Constants.NEW_CONVO) {
      console.log('Starting new conversation, resetting artifacts');
      console.log('Starting new conversation, resetting artifacts');
      resetState();
    } else {
      if (!cacheLoaded) {
        console.log('⏸️ [useArtifacts] Waiting for cache to load before loading artifacts...');
        return;
      }

      // Load artifacts for current conversation if not already loaded
      if (!artifacts || Object.keys(artifacts).length === 0) {
        const storedArtifacts = loadArtifactsFromStorage(conversationId);
        if (storedArtifacts) {
          console.log('📦 [useArtifacts] Loaded artifacts from storage:', {
            count: Object.keys(storedArtifacts).length,
            updateCount: Object.values(storedArtifacts).filter((a) => a?.isUpdate).length,
            baseCount: Object.values(storedArtifacts).filter((a) => !a?.isUpdate).length,
            selectionCacheSize: artifactCache._selectionCache.size,
          });
          setArtifacts(storedArtifacts);
        } else {
          console.log('No stored artifacts found for conversation:', conversationId);
        }
      } else {
        console.log('Artifacts already loaded:', Object.keys(artifacts));
      }
    }

    // Update stored conversation ID
    saveConversationIdToStorage(conversationId);
    prevConversationIdRef.current = conversationId;
    return () => {
      console.log('artifacts_visibility', 'Unmounting artifacts');
      // resetState();
      console.log('artifacts_visibility', 'Unmounting artifacts');
      // resetState();
    };
  }, [
    conversationId,
    cacheLoaded, // CRITICAL: Wait for cache to load before loading artifacts
    resetArtifacts,
    resetCurrentArtifactId,
    resetArtifactsVisibility,
    resetVisibleArtifacts,
    artifacts,
    setArtifacts,
  ]);

  // CRITICAL: Save artifacts to localStorage whenever they change
  // This ensures update artifacts are persisted and available on page refresh
  useEffect(() => {
    if (artifacts && conversationId && conversationId !== Constants.NEW_CONVO) {
      console.log('💾 [useArtifacts] Saving artifacts to storage:', {
        conversationId,
        artifactCount: Object.keys(artifacts).length,
        artifactKeys: Object.keys(artifacts),
        updateArtifacts: Object.values(artifacts)
          .filter((a) => a?.isUpdate)
          .map((a) => a?.id),
        baseArtifacts: Object.values(artifacts)
          .filter((a) => !a?.isUpdate)
          .map((a) => a?.id),
      });
      saveArtifactsToStorage(artifacts, conversationId);
    }
  }, [artifacts, conversationId]);

  // Set current artifact ID to the latest artifact ONLY if not already set,
  // or if the artifact list changes and the currentArtifactId is no longer present.
  // CRITICAL: This should ONLY run when currentArtifactId is null or invalid,
  // NOT when user manually selects an artifact button
  useEffect(() => {
    if (orderedArtifactIds.length > 0) {
      // If currentArtifactId is not set or is not in the list, set to latest
      if (!currentArtifactId || !orderedArtifactIds.includes(currentArtifactId)) {
        const latestArtifactId = orderedArtifactIds[orderedArtifactIds.length - 1];
        setCurrentArtifactId(latestArtifactId);
      }
    }
  }, [setCurrentArtifactId, orderedArtifactIds, currentArtifactId]);

  // When switching to an artifactupdate, always trigger a refresh to ensure merge
  useEffect(() => {
    if (!currentArtifactId) return;
    const current = artifacts?.[currentArtifactId];
    if (current && current.type === 'artifactupdate') {
      // Only trigger refresh once per artifact to prevent infinite loop
      if (!refreshedArtifactsRef.current.has(currentArtifactId)) {
        refreshedArtifactsRef.current.add(currentArtifactId);
        setRefreshTrigger((prev) => prev + 1);
      }
    }
  }, [currentArtifactId, artifacts, setRefreshTrigger]);

  // Handle artifact updates and tab switching during message generation
  // When switching to an artifactupdate, always trigger a refresh to ensure merge
  useEffect(() => {
    if (!currentArtifactId) return;
    const current = artifacts?.[currentArtifactId];
    if (current && current.type === 'artifactupdate') {
      // Only trigger refresh once per artifact to prevent infinite loop
      if (!refreshedArtifactsRef.current.has(currentArtifactId)) {
        refreshedArtifactsRef.current.add(currentArtifactId);
        setRefreshTrigger((prev) => prev + 1);
      }
    }
  }, [currentArtifactId, artifacts, setRefreshTrigger]);

  // Handle artifact updates and tab switching during message generation
  useEffect(() => {
    // Check if we just finished submitting (transition from true to false)
    const justFinishedSubmitting = prevIsSubmittingRef.current && !isSubmitting;
    prevIsSubmittingRef.current = isSubmitting;

    // Only process during submission OR when just finished
    if (!isSubmitting && !justFinishedSubmitting) {
      return;
    }
    if (orderedArtifactIds.length === 0) {
      return;
    }
    if (latestMessageId == null) {
      return;
    }
    const latestArtifactId = orderedArtifactIds[orderedArtifactIds.length - 1];
    const latestArtifact = artifacts?.[latestArtifactId];
    if (latestArtifact?.content === lastContentRef.current && !justFinishedSubmitting) {
      return;
    }

    if (!currentArtifactId) {
      setCurrentArtifactId(latestArtifactId);
    }
    lastContentRef.current = latestArtifact?.content ?? null;

    console.log('latestMessageText', latestMessageText);

    // Detect standard artifact syntax
    console.log('latestMessageText', latestMessageText);

    // Detect standard artifact syntax
    const hasEnclosedArtifact =
      /:::artifact(?:\{[^}]*\})?(?:\s|\n)*(?:```[\s\S]*?```(?:\s|\n)*)?:::/m.test(
        latestMessageText.trim(),
      );
    console.log('hasEnclosedArtifact', hasEnclosedArtifact);

    // Detect artifact update marker
    const hasArtifactUpdate = latestMessageText.includes('::artifactupdate');
    console.log('hasArtifactUpdate', hasArtifactUpdate);

    // Check if there's a cached update for this artifact
    const hasCachedUpdate = latestArtifact?.id && artifactCache.isSelectionValid(latestArtifact.id);
    console.log('hasCachedUpdate for', latestArtifact?.id, hasCachedUpdate);
    console.log('hasEnclosedArtifact', hasEnclosedArtifact);

    // Detect artifact update marker
    const hasArtifactUpdate = latestMessageText.includes('::artifactupdate');
    console.log('hasArtifactUpdate', hasArtifactUpdate);

    // Check if there's a cached update for this artifact
    const hasCachedUpdate = latestArtifact?.id && artifactCache.isSelectionValid(latestArtifact.id);
    console.log('hasCachedUpdate for', latestArtifact?.id, hasCachedUpdate);

    if (hasEnclosedArtifact && !hasEnclosedArtifactRef.current) {
      // New artifact created, switch to preview
      // New artifact created, switch to preview
      setActiveTab('preview');
      hasEnclosedArtifactRef.current = true;
      hasAutoSwitchedToCodeRef.current = false;
    } else if (hasArtifactUpdate || hasCachedUpdate) {
      // Artifact update detected, switch to code view
      console.log('Artifact update detected, switching to code view');
      setActiveTab('code');
      hasEnclosedArtifactRef.current = true;
      pendingArtifactUpdateRef.current = true;

      // Trigger a refresh to ensure the artifact updates (only once per artifact)
      const artifactIdToRefresh = latestArtifactId;
      if (!refreshedArtifactsRef.current.has(artifactIdToRefresh)) {
        refreshedArtifactsRef.current.add(artifactIdToRefresh);
        setTimeout(() => {
          setRefreshTrigger((prev) => prev + 1);
        }, 750);
      }
    } else if (hasArtifactUpdate || hasCachedUpdate) {
      // Artifact update detected, switch to code view
      console.log('Artifact update detected, switching to code view');
      setActiveTab('code');
      hasEnclosedArtifactRef.current = true;
      pendingArtifactUpdateRef.current = true;

      // Trigger a refresh to ensure the artifact updates (only once per artifact)
      const artifactIdToRefresh = latestArtifactId;
      if (!refreshedArtifactsRef.current.has(artifactIdToRefresh)) {
        refreshedArtifactsRef.current.add(artifactIdToRefresh);
        setTimeout(() => {
          setRefreshTrigger((prev) => prev + 1);
        }, 750);
      }
    } else if (!hasEnclosedArtifactRef.current && !hasAutoSwitchedToCodeRef.current) {
      // Check if current message contains artifact content
      // Check if current message contains artifact content
      const artifactStartContent = latestArtifact?.content?.slice(0, 50) ?? '';
      if (artifactStartContent.length > 0 && latestMessageText.includes(artifactStartContent)) {
        setActiveTab('code');
        hasAutoSwitchedToCodeRef.current = true;
      }
    }
  }, [
    artifacts,
    isSubmitting,
    latestMessageId,
    latestMessageText,
    orderedArtifactIds,
    currentArtifactId,
    setCurrentArtifactId,
    setRefreshTrigger,
  ]);

  /**
   * Watch for enclosed artifact pattern during message generation
   * Optimized: Exits early if already detected, only checks during streaming
   */
  useEffect(() => {
    if (!isSubmitting || hasEnclosedArtifactRef.current) {
      return;
    }

    const hasEnclosedArtifact =
      /:::artifact(?:\{[^}]*\})?(?:\s|\n)*(?:```[\s\S]*?```(?:\s|\n)*)?:::/m.test(
        latestMessageText.trim(),
      );

    if (hasEnclosedArtifact) {
      logger.log('artifacts', 'Enclosed artifact detected during generation, switching to preview');
      setActiveTab('preview');
      hasEnclosedArtifactRef.current = true;
      hasAutoSwitchedToCodeRef.current = false;
    }
  }, [isSubmitting, latestMessageText]);

  // Reset flags when message ID changes
  useEffect(() => {
    if (latestMessageId !== lastRunMessageIdRef.current) {
      lastRunMessageIdRef.current = latestMessageId;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
      pendingArtifactUpdateRef.current = false;
      refreshedArtifactsRef.current.clear(); // Clear refresh tracking for new message
      pendingArtifactUpdateRef.current = false;
      refreshedArtifactsRef.current.clear(); // Clear refresh tracking for new message
    }
  }, [latestMessageId]);

  const currentArtifact = currentArtifactId != null ? artifacts?.[currentArtifactId] : null;

  // CRITICAL: Use useMemo to ensure currentDisplayArtifact updates when artifacts or artifactId changes
  // Without this, the UI won't refresh when artifact content is updated
  const currentDisplayArtifact = useMemo(() => {
    if (currentArtifactId == null || !artifacts) {
      console.log('🔄 [useArtifacts] No artifact to display:', {
        hasArtifactId: !!currentArtifactId,
        hasArtifacts: !!artifacts,
      });
      return null;
    }
    const displayArtifact = artifactCache.getDisplayArtifact(currentArtifactId, artifacts);
    return displayArtifact;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentArtifactId, artifacts, _refreshTrigger]);

  useEffect(() => {
    console.log(
      '[useArtifacts] currentArtifactId:',
      currentArtifactId,
      'currentArtifact:',
      currentArtifact?.title,
      'orderedArtifactIds:',
      orderedArtifactIds,
    );
  }, [currentArtifactId, currentArtifact, orderedArtifactIds]);
  // Monitor the latest message for artifact updates
  useEffect(() => {
    if (!latestMessageText) return;
  }, [latestMessageText, currentArtifactId, setRefreshTrigger, currentArtifact]);

  const currentIndex = orderedArtifactIds.indexOf(currentArtifactId ?? '');
  const _cycleArtifact = (direction: 'next' | 'prev') => {
    let newIndex: number;
    if (direction === 'next') {
      newIndex = (currentIndex + 1) % orderedArtifactIds.length;
    } else {
      newIndex = (currentIndex - 1 + orderedArtifactIds.length) % orderedArtifactIds.length;
    }
    setCurrentArtifactId(orderedArtifactIds[newIndex]);
  };

  const refreshArtifact = useCallback(
    (artifactId) => {
      if (!artifactId) return;
      console.log(`Manually refreshing artifact ${artifactId}`);
      setRefreshTrigger((prev) => prev + 1);
    },
    [setRefreshTrigger],
  );

  return {
    activeTab,
    isMermaid,
    setActiveTab,
    currentIndex,
    currentArtifact: currentDisplayArtifact, // Use the display artifact everywhere
    orderedArtifactIds,
    refreshArtifact, // Add this new function
    artifactCache: artifactCache,
    setCurrentArtifactId,
    cacheLoaded,
  };
}
