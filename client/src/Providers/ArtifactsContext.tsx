import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import { useChatContext } from './ChatContext';
import { getLatestText } from '~/utils';
import { extractAllArtifactsFromMessage } from '~/utils/extractArtifacts';
import { artifactsState } from '~/store/artifacts';
import store from '~/store';

interface ArtifactsContextValue {
  isSubmitting: boolean;
  latestMessageId: string | null;
  latestMessageText: string;
  conversationId: string | null;
}

const ArtifactsContext = createContext<ArtifactsContextValue | undefined>(undefined);

export function ArtifactsProvider({ children }: { children: React.ReactNode }) {
  const { isSubmitting, latestMessage, conversation } = useChatContext();

  const [_artifact, setArtifacts] = useRecoilState(artifactsState);
  const [_artifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);

  useEffect(() => {
    // Check all messages in the conversation for artifacts, not just the latest
    if (conversation?.messages && Array.isArray(conversation.messages)) {
      const allArtifactsFromConversation: any[] = [];

      conversation.messages.forEach((message: any) => {
        if (message?.text) {
          const messageArtifacts = extractAllArtifactsFromMessage(message.text, message.messageId);
          allArtifactsFromConversation.push(...messageArtifacts);
        }
      });

      console.log(
        '🎯 [ArtifactsProvider] Found artifacts from all messages:',
        allArtifactsFromConversation.length,
      );

      if (allArtifactsFromConversation.length > 0) {
        // Group artifacts by base identifier, but keep BOTH original and updated versions
        const artifactsByIdentifier = new Map();

        allArtifactsFromConversation.forEach((artifact) => {
          const baseIdentifier =
            artifact.identifier?.replace(/-updated-\d+$/, '') || artifact.identifier;
          if (!artifactsByIdentifier.has(baseIdentifier)) {
            artifactsByIdentifier.set(baseIdentifier, []);
          }
          artifactsByIdentifier.get(baseIdentifier).push(artifact);
        });

        // Keep BOTH original and updated artifacts for each base identifier
        const preservedArtifacts: any[] = [];
        artifactsByIdentifier.forEach((artifacts) => {
          // Sort by update time
          const sortedArtifacts = artifacts.sort((a: any, b: any) => {
            const timeA = a.lastUpdateTime || 0;
            const timeB = b.lastUpdateTime || 0;
            return timeA - timeB; // Oldest first
          });

          // Keep ALL artifacts - both original and updated versions
          preservedArtifacts.push(...sortedArtifacts);
        });

        const artifactMap = Object.fromEntries(preservedArtifacts.map((a) => [a.id, a]));
        console.log('💾 [ArtifactsProvider] Keeping both original and updated artifacts:', {
          total: allArtifactsFromConversation.length,
          preserved: preservedArtifacts.length,
          artifacts: preservedArtifacts.map((a) => ({
            id: a.identifier,
            title: a.title,
            isOriginal: !!a.isUpdate,
            isUpdated: a.isUpdate,
          })),
        });
        setArtifacts(artifactMap);
        setVisibleArtifacts(artifactMap);
      }
    }
    // Also check the latest message as a fallback
    else if (latestMessage?.text) {
      console.log('📝 [ArtifactsProvider] Fallback: checking latest message only');
      const allArtifacts = extractAllArtifactsFromMessage(
        latestMessage.text,
        latestMessage.messageId,
      );
      if (allArtifacts.length > 0) {
        const artifactMap = Object.fromEntries(allArtifacts.map((a) => [a.id, a]));
        setArtifacts((prev) => ({ ...prev, ...artifactMap }));
        setVisibleArtifacts((prev) => ({ ...prev, ...artifactMap }));
      }
    }
  }, [
    conversation?.messages,
    latestMessage?.text,
    latestMessage?.messageId,
    setArtifacts,
    setVisibleArtifacts,
  ]);

  const latestMessageText = useMemo(() => {
    return getLatestText({
      messageId: latestMessage?.messageId ?? null,
      text: latestMessage?.text ?? null,
      content: latestMessage?.content ?? null,
    } as TMessage);
  }, [latestMessage?.messageId, latestMessage?.text, latestMessage?.content]);

  /** Context value only created when relevant values change */
  const contextValue = useMemo<ArtifactsContextValue>(
    () => ({
      isSubmitting,
      latestMessageText,
      latestMessageId: latestMessage?.messageId ?? null,
      conversationId: conversation?.conversationId ?? null,
    }),
    [isSubmitting, latestMessage?.messageId, latestMessageText, conversation?.conversationId],
  );

  return <ArtifactsContext.Provider value={contextValue}>{children}</ArtifactsContext.Provider>;
}

export function useArtifactsContext() {
  const context = useContext(ArtifactsContext);
  if (!context) {
    throw new Error('useArtifactsContext must be used within ArtifactsProvider');
  }
  return context;
}
