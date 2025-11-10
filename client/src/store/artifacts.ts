import { atom } from 'recoil';
import { logger } from '~/utils';
import type { Artifact } from '~/common';

const ARTIFACTS_STORAGE_KEY = 'librechat-artifacts';

// Helper function to get conversation-specific key
const getConversationArtifactsKey = (conversationId?: string | null) => {
  if (!conversationId || conversationId === 'new') {
    return `${ARTIFACTS_STORAGE_KEY}-new`;
  }
  return `${ARTIFACTS_STORAGE_KEY}-${conversationId}`;
};

// Helper function to save artifacts to localStorage
const saveArtifactsToStorage = (
  artifacts: Record<string, Artifact | undefined> | null,
  conversationId?: string | null,
) => {
  try {
    const key = getConversationArtifactsKey(conversationId);
    if (artifacts) {
      localStorage.setItem(key, JSON.stringify(artifacts));
    } else {
      localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn('Failed to save artifacts to localStorage:', error);
  }
};

// Helper function to load artifacts from localStorage
const loadArtifactsFromStorage = (
  conversationId?: string | null,
): Record<string, Artifact | undefined> | null => {
  try {
    const key = getConversationArtifactsKey(conversationId);
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn('Failed to load artifacts from localStorage:', error);
    return null;
  }
};

// Export helper functions for external use
export { saveArtifactsToStorage, loadArtifactsFromStorage };

export const artifactsState = atom<Record<string, Artifact | undefined> | null>({
  key: 'artifactsState',
  default: null, // Will be loaded dynamically based on conversation
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting artifactsState', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

const CURRENT_ARTIFACT_ID_STORAGE_KEY = 'librechat-current-artifact-id';
const CONVERSATION_ID_STORAGE_KEY = 'librechat-conversation-id';

// Helper function to save current artifact ID to localStorage
const saveCurrentArtifactIdToStorage = (artifactId: string | null) => {
  try {
    if (artifactId) {
      localStorage.setItem(CURRENT_ARTIFACT_ID_STORAGE_KEY, artifactId);
    } else {
      localStorage.removeItem(CURRENT_ARTIFACT_ID_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Failed to save current artifact ID to localStorage:', error);
  }
};

// Helper function to load current artifact ID from localStorage
const loadCurrentArtifactIdFromStorage = (): string | null => {
  try {
    return localStorage.getItem(CURRENT_ARTIFACT_ID_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to load current artifact ID from localStorage:', error);
    return null;
  }
};

// Helper functions for conversation ID persistence
export const saveConversationIdToStorage = (conversationId: string | null) => {
  try {
    if (conversationId) {
      localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, conversationId);
    } else {
      localStorage.removeItem(CONVERSATION_ID_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Failed to save conversation ID to localStorage:', error);
  }
};

export const loadConversationIdFromStorage = (): string | null => {
  try {
    return localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to load conversation ID from localStorage:', error);
    return null;
  }
};

export const currentArtifactId = atom<string | null>({
  key: 'currentArtifactId',
  default: loadCurrentArtifactIdFromStorage(),
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting currentArtifactId', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

export const artifactsVisibility = atom<boolean>({
  key: 'artifactsVisibility',
  default: true,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting artifactsVisibility', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

export const visibleArtifacts = atom<Record<string, Artifact | undefined> | null>({
  key: 'visibleArtifacts',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting `visibleArtifacts`', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});
