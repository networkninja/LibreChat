import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Constants } from 'librechat-data-provider';
import { useRecoilState, useResetRecoilState } from 'recoil';
import { logger } from '~/utils';
import { useArtifactsContext } from '~/Providers';
import { getKey } from '~/utils/artifacts';
import store from '~/store';
import { artifactCache } from '~/components/Artifacts/ArtifactCache';
import {
  saveConversationIdToStorage,
  loadConversationIdFromStorage,
  saveArtifactsToStorage,
  loadArtifactsFromStorage,
} from '~/store/artifacts';
import { atom, AtomOptions } from 'recoil';

const atomRegistry = new Map();
/**
 * Creates an atom with the given key only if it hasn't been created before
 */
function createUniqueAtom<T>(options: AtomOptions<T>) {
  if (atomRegistry.has(options.key)) {
    // Return existing atom instead of creating a new one
    return atomRegistry.get(options.key);
  }
  const newAtom = atom(options);
  atomRegistry.set(options.key, newAtom);
  return newAtom;
}

// Create our specific atoms
export const artifactRefreshTriggerState = createUniqueAtom({
  key: 'artifactRefreshTrigger',
  default: 0,
});

export default function useArtifacts() {
  const [activeTab, setActiveTab] = useState('preview');
  const { isSubmitting, latestMessageId, latestMessageText, conversationId } =
    useArtifactsContext();

  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const [_refreshTrigger, setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);

  // Initialize cache from localStorage on first load
  useEffect(() => {
    artifactCache.init();

    // Load conversation cache from database on page refresh
    if (conversationId && conversationId !== Constants.NEW_CONVO) {
      console.log(
        '🔄 [useArtifacts] Loading conversation cache from database for:',
        conversationId,
      );
      artifactCache.loadConversationCache(conversationId).catch((error) => {
        console.error('Failed to load conversation cache from database:', error);
      });
    }
  }, [conversationId]);

  const orderedArtifactIds = useMemo(() => {
    return Object.keys(artifacts ?? {}).sort(
      (a, b) => (artifacts?.[a]?.lastUpdateTime ?? 0) - (artifacts?.[b]?.lastUpdateTime ?? 0),
    );
  }, [artifacts]);

  const lastContentRef = useRef<string | null>(null);
  const hasEnclosedArtifactRef = useRef<boolean>(false);
  const hasAutoSwitchedToCodeRef = useRef<boolean>(false);
  const lastRunMessageIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | null>(null);
  const pendingArtifactUpdateRef = useRef<boolean>(false);

  // Reset artifacts and cache when conversation changes
  useEffect(() => {
    const resetState = () => {
      resetArtifacts();
      resetCurrentArtifactId();
      prevConversationIdRef.current = conversationId;
      lastRunMessageIdRef.current = null;
      lastContentRef.current = null;
      hasEnclosedArtifactRef.current = false;
      pendingArtifactUpdateRef.current = false;

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

    if (isConversationChange) {
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
      resetState();
    } else {
      console.log('Page refresh detected, loading artifacts for conversation:', conversationId);

      // Load artifacts for current conversation if not already loaded
      if (!artifacts || Object.keys(artifacts).length === 0) {
        const storedArtifacts = loadArtifactsFromStorage(conversationId);
        if (storedArtifacts) {
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
    /** Resets artifacts when unmounting */
    return () => {
      logger.log('artifacts_visibility', 'Unmounting artifacts');
      resetState();
    };
  }, [conversationId, resetArtifacts, resetCurrentArtifactId, artifacts, setArtifacts]);

  useEffect(() => {
    if (orderedArtifactIds.length > 0) {
      // If currentArtifactId is not set or is not in the list, set to latest
      if (!currentArtifactId || !orderedArtifactIds.includes(currentArtifactId)) {
        const latestArtifactId = orderedArtifactIds[orderedArtifactIds.length - 1];
        setCurrentArtifactId(latestArtifactId);
      }
    }
  }, [setCurrentArtifactId, orderedArtifactIds, currentArtifactId, artifacts]);

  // When switching to an artifactupdate, always trigger a refresh to ensure merge
  useEffect(() => {
    if (!currentArtifactId) return;
    const current = artifacts?.[currentArtifactId];
    if (current && current.type === 'artifactupdate') {
      setRefreshTrigger((prev) => prev + 1);
    }
  }, [currentArtifactId, artifacts, setRefreshTrigger]);

  // Handle artifact updates and tab switching during message generation
  useEffect(() => {
    if (!isSubmitting) {
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
    if (latestArtifact?.content === lastContentRef.current) {
      return;
    }

    setCurrentArtifactId(latestArtifactId);
    lastContentRef.current = latestArtifact?.content ?? null;

    const hasEnclosedArtifact =
      /:::artifact(?:\{[^}]*\})?(?:\s|\n)*(?:```[\s\S]*?```(?:\s|\n)*)?:::/m.test(
        latestMessageText.trim(),
      );
    // Detect artifact update marker
    const hasArtifactUpdate = latestMessageText.includes('::artifactupdate');

    // Check if there's a cached update for this artifact
    const hasCachedUpdate = latestArtifact?.id && artifactCache.isSelectionValid(latestArtifact.id);

    if (hasEnclosedArtifact && !hasEnclosedArtifactRef.current) {
      setActiveTab('preview');
      hasEnclosedArtifactRef.current = true;
      hasAutoSwitchedToCodeRef.current = false;
    } else if (hasArtifactUpdate || hasCachedUpdate) {
      // Artifact update detected, switch to code view
      console.log('Artifact update detected, switching to code view');
      setActiveTab('code');
      hasEnclosedArtifactRef.current = true;
      pendingArtifactUpdateRef.current = true;

      // Trigger a refresh to ensure the artifact updates
      setTimeout(() => {
        setRefreshTrigger((prev) => prev + 1);
      }, 750);
    } else if (!hasEnclosedArtifactRef.current && !hasAutoSwitchedToCodeRef.current) {
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
    setCurrentArtifactId,
    setRefreshTrigger,
  ]);

  useEffect(() => {
    if (latestMessageId !== lastRunMessageIdRef.current) {
      lastRunMessageIdRef.current = latestMessageId;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
      pendingArtifactUpdateRef.current = false;
    }
  }, [latestMessageId]);

  const currentArtifact = currentArtifactId != null ? artifacts?.[currentArtifactId] : null;
  // Use the unified artifact retrieval for the current artifact
  const currentDisplayArtifact =
    currentArtifactId != null
      ? artifactCache.getDisplayArtifact(currentArtifactId, artifacts)
      : null;
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

    // Check for artifact update markers
    if (latestMessageText.includes('::artifactupdate')) {
      console.log('Detected ::artifactupdate marker in message', latestMessageText);
      // console.log("currentArtifact ", currentArtifact?.content);
      // if (currentArtifact) {
      //   currentArtifact.content = latestMessageText;
      //   currentArtifact.updatedContent = latestMessageText;
      // }
      if (currentArtifactId && !pendingArtifactUpdateRef.current) {
        console.log(`Checking for cached updates for artifact ${currentArtifactId}`, artifactCache);
        //if (artifactCache.isSelectionValid(currentArtifactId)) {
        console.log(`Found valid cached update for artifact ${currentArtifactId}`);

        // Trigger a refresh to apply the update
        setRefreshTrigger((prev) => prev + 1);
        pendingArtifactUpdateRef.current = true;
      }
      //}
    }
  }, [latestMessageText, currentArtifactId, setRefreshTrigger, currentArtifact]);

  const currentIndex = orderedArtifactIds.indexOf(currentArtifactId ?? '');
  const cycleArtifact = (direction: 'next' | 'prev') => {
    let newIndex: number;
    if (direction === 'next') {
      newIndex = (currentIndex + 1) % orderedArtifactIds.length;
    } else {
      newIndex = (currentIndex - 1 + orderedArtifactIds.length) % orderedArtifactIds.length;
    }
    setCurrentArtifactId(orderedArtifactIds[newIndex]);
  };

  const isMermaid = useMemo(() => {
    if (currentArtifact?.type == null) {
      return false;
    }
    const key = getKey(currentArtifact.type, currentArtifact.language);
    return key.includes('mermaid');
  }, [currentArtifact?.type, currentArtifact?.language]);

  //Add function to force refresh an artifact
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
    cycleArtifact,
    currentArtifact: currentDisplayArtifact,
    orderedArtifactIds,
    refreshArtifact,
    artifactCache: artifactCache,
  };
}
