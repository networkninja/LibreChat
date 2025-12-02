import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import { useChatContext } from './ChatContext';
import { getLatestText } from '~/utils';
import { extractAllArtifactsFromMessage } from '~/utils/extractArtifacts';
import { artifactsState } from '~/store/artifacts';
import store from '~/store';

export interface ArtifactsContextValue {
  isSubmitting: boolean;
  isStreaming: boolean;
  latestMessageId: string | null;
  latestMessageText: string;
  conversationId: string | null;
  isMessageStreaming: boolean;
  latestMessage: TMessage | null;
}

const ArtifactsContext = createContext<ArtifactsContextValue | undefined>(undefined);

interface ArtifactsProviderProps {
  children: React.ReactNode;
  value?: Partial<ArtifactsContextValue>;
}

export function ArtifactsProvider({ children, value }: ArtifactsProviderProps) {
  const { isSubmitting, latestMessage, conversation } = useChatContext();

  const [_artifact, setArtifacts] = useRecoilState(artifactsState);
  const [_artifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);

  useEffect(() => {
    const currentConversationId = conversation?.conversationId ?? null;

    // Check all messages in the conversation for artifacts, not just the latest
    if (conversation?.messages && Array.isArray(conversation.messages)) {
      const allArtifactsFromConversation: any[] = [];

      conversation.messages.forEach((message: any) => {
        if (message?.text) {
          const messageArtifacts = extractAllArtifactsFromMessage(message.text, message.messageId);
          messageArtifacts.forEach((artifact) => {
            artifact.conversationId = currentConversationId;
          });
          allArtifactsFromConversation.push(...messageArtifacts);
        }
      });

      if (allArtifactsFromConversation.length > 0) {
        // Group artifacts by base identifier, but keep BOTH original and updated versions
        const artifactsByIdentifier = new Map();

        allArtifactsFromConversation.forEach((artifact) => {
          const baseIdentifier = artifact.identifier || artifact.id;

          if (!artifactsByIdentifier.has(baseIdentifier)) {
            artifactsByIdentifier.set(baseIdentifier, []);
          }
          artifactsByIdentifier.get(baseIdentifier).push(artifact);
        });

        // Keep BOTH original and updated artifacts for each base identifier
        const preservedArtifacts: any[] = [];
        artifactsByIdentifier.forEach((artifacts) => {
          // Sort by index (version number) to maintain chronological order
          const sortedArtifacts = artifacts.sort((a: any, b: any) => {
            // If both have index, sort by index (lower index = earlier version)
            if (typeof a.index === 'number' && typeof b.index === 'number') {
              return a.index - b.index;
            }
            // Fallback to time-based sorting
            const timeA = a.lastUpdateTime || 0;
            const timeB = b.lastUpdateTime || 0;
            return timeA - timeB; // Oldest first
          });

          // Keep ALL artifacts - both original and updated versions
          preservedArtifacts.push(...sortedArtifacts);
        });

        const artifactMap = Object.fromEntries(preservedArtifacts.map((a) => [a.id, a]));
        setArtifacts(artifactMap);
        setVisibleArtifacts(artifactMap);
      }
    }
    // Also check the latest message as a fallback
    else if (latestMessage?.text) {
      const allArtifacts = extractAllArtifactsFromMessage(
        latestMessage.text,
        latestMessage.messageId,
      );
      if (allArtifacts.length > 0) {
        allArtifacts.forEach((artifact) => {
          artifact.conversationId = currentConversationId;
        });
        const artifactMap = Object.fromEntries(allArtifacts.map((a) => [a.id, a]));
        setArtifacts((prev) => ({ ...prev, ...artifactMap }));
        setVisibleArtifacts((prev) => ({ ...prev, ...artifactMap }));
      }
    }
  }, [
    conversation?.messages,
    conversation?.conversationId,
    latestMessage?.text,
    latestMessage?.messageId,
    latestMessage?.unfinished,
    setArtifacts,
    setVisibleArtifacts,
  ]);

  const chatLatestMessageText = useMemo(() => {
    return getLatestText({
      messageId: latestMessage?.messageId ?? null,
      text: latestMessage?.text ?? null,
      content: latestMessage?.content ?? null,
    } as TMessage);
  }, [latestMessage?.messageId, latestMessage?.text, latestMessage?.content]);

  const defaultContextValue = useMemo<ArtifactsContextValue>(() => {
    const isStreamingValue = latestMessage?.unfinished === true;
    return {
      isSubmitting,
      isStreaming: isStreamingValue,
      latestMessageText: chatLatestMessageText,
      latestMessageId: latestMessage?.messageId ?? null,
      conversationId: conversation?.conversationId ?? null,
    };
  }, [
    isSubmitting,
    latestMessage?.unfinished,
    chatLatestMessageText,
    latestMessage?.messageId,
    conversation?.conversationId,
  ]);

  /** Context value only created when relevant values change */
  const contextValue = useMemo<ArtifactsContextValue>(
    () => (value ? { ...defaultContextValue, ...value } : defaultContextValue),
    [defaultContextValue, value],
  );

  return <ArtifactsContext.Provider value={contextValue}>{children}</ArtifactsContext.Provider>;
}

export function useArtifactsContext() {
  const context = useContext(ArtifactsContext);
  if (!context) {
    // Return a safe default instead of throwing
    // This allows the component to work in contexts where the provider isn't available
    console.warn('⚠️ useArtifactsContext called without ArtifactsProvider - using defaults');
    return {
      isSubmitting: false,
      isStreaming: false,
      latestMessageId: null,
      latestMessageText: '',
      conversationId: null,
    };
  }
  return context;
}
