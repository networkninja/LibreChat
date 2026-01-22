import React, { useEffect, useCallback, useRef, useState } from 'react';
import { visit } from 'unist-util-visit';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext, useArtifactsContext } from '~/Providers';
import { extractNodes, extractContent } from '~/utils';
import { artifactsState, artifactRefreshTriggerState } from '~/store/artifacts';
import ArtifactButton from './ArtifactButton';
import { artifactCache } from './artifactCache';
import store from '~/store';
import { applyPartialUpdate, applyAllPartialUpdates } from '~/hooks/Artifacts/useArtifactUtlis';

export const artifactPlugin: Pluggable = () => {
  return (tree) => {
    visit(tree, ['textDirective', 'leafDirective', 'containerDirective'], (node, index, parent) => {
      if (node.type === 'textDirective') {
        const replacementText = `:${node.name}`;
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children[index] = {
            type: 'text',
            value: replacementText,
          };
        }
      }
      console.log('node name', node.name, node);
      // Handle selection directive
      if (node.name === 'selection') {
        // The selection content is in the directive's children array
        const extractTextRecursive = (n: any): string => {
          let text = '';

          if (n.type === 'text') {
            text += n.value;
          }

          if (Array.isArray(n.children)) {
            n.children.forEach((child: any) => {
              text += extractTextRecursive(child);
              // Add newline after paragraphs ONLY if it's not the last paragraph
              // This prevents picking up extra content after the directive
              if (child.type === 'paragraph') {
                text += '\n';
              }
            });
          }

          return text;
        };

        // Extract ONLY from the directive node's children (not siblings)
        const selectionText = extractTextRecursive(node).trim();
        if (!node.data) {
          node.data = {};
        }
        node.data.selectionText = selectionText;
        node.data.hName = 'selection';
        node.data.hProperties = node.data.hProperties || {};

        node.data.hProperties = {
          ...node.data.hProperties,
          selectionText: selectionText, // This becomes a prop on the React component
        };
        return node;
      }

      if (node.name !== 'artifact' && node.name !== 'artifactupdate') {
        return;
      }
      // Try to extract attributes from different possible locations
      let extractedAttributes = node.attributes || {};

      // Check if attributes are in node.data
      if (node.data && node.data.attributes) {
        extractedAttributes = { ...extractedAttributes, ...node.data.attributes };
      }

      // remark-directive also stores attributes in node.data.hProperties sometimes
      if (node.data && node.data.hProperties) {
        extractedAttributes = { ...extractedAttributes, ...node.data.hProperties };
      }

      if (node.name === 'artifactupdate' && extractedAttributes.identifier) {
        console.log('Processing artifactupdate with identifier:', extractedAttributes.identifier);
        // Extract code block from children
        let codeBlock = '';
        console.log('node children', node.children);
        if (Array.isArray(node.children)) {
          const codeChild = node.children.find(
            (child: any) => child.type === 'code' && typeof child.value === 'string',
          );
          if (codeChild && codeChild.value) {
            codeBlock = codeChild.value;
          }
        }
        if (codeBlock) {
          // During streaming, the plugin runs MULTIPLE TIMES on the SAME artifact
          // We only want to update when we receive MORE content, not re-process the same content
          const previousCode = node.data?.extractedCode || '';
          const isNewOrLonger = codeBlock.length > previousCode.length;

          if (isNewOrLonger) {
            if (!node.data) {
              node.data = {};
            }
            node.data.extractedCode = codeBlock;
            node.data.extractedAttributes = extractedAttributes;
          }
        }
      }

      // Check if there are any other attribute sources
      if (node.label) {
        extractedAttributes.identifier = node.label;
      }
      node.data = {
        hName: node.name,
        hProperties: node.attributes,
        ...node.data,
      };
      return node;
    });
  };
};

const defaultTitle = 'untitled';
const defaultType = 'unknown';
const defaultIdentifier = 'lc-no-identifier';

export function Artifact({
  node,
  ...props
}: Artifact & {
  children: React.ReactNode | { props: { children: React.ReactNode } };
  node: unknown;
}) {
  // Check for directive info in multiple places
  const nodeTag = (node as any)?.tagName;
  const nodeType = (node as any)?.type;

  // console.log('Artifact node analysis:', { node, nodeTag, nodeType });

  const isArtifactUpdateNode =
    nodeTag === 'artifactupdate' || (nodeType === 'element' && nodeTag === 'artifactupdate');

  const location = useLocation();
  const { messageId } = useMessageContext();
  const { resetCounter } = useArtifactContext();
  const artifactsContext = useArtifactsContext();

  // Get conversationId from context, with URL fallback if null
  const conversationId =
    artifactsContext.conversationId || location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;

  const [_artifacts, setArtifacts] = useRecoilState(artifactsState);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [_visibleArtifacts, _setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const [_currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const lastUpdateKey = useRef<string | null>(null);
  const lastContent = useRef<string | null>(null);
  const lastSnippet = useRef<string | null>(null); // Track the SNIPPET (not merged content)
  const _lastProcessedContentHash = useRef<string | null>(null); // Track processed content by hash
  const [_refreshTrigger, _setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);

  // Track streaming state to save cache only when complete
  const lastIsSubmittingRef = useRef<boolean>(false);
  const pendingCacheUpdates = useRef<
    Map<string, { content: string; metadata: any; conversationId?: string; messageId?: string }>
  >(new Map());

  useEffect(() => {
    const handleBeforeUnload = () => {
      artifactCache.flushPendingSyncs();
    };

    // Add event listener for page unload
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Cleanup function called when component unmounts
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      artifactCache.flushPendingSyncs();
    };
  }, []);

  let displayArtifact;
  useEffect(() => {
    const wasStreaming = lastIsSubmittingRef.current;
    const isNowComplete = !artifactsContext.isSubmitting; // Changed from isStreaming to isSubmitting

    if (wasStreaming && isNowComplete) {
      setTimeout(() => {
        const recentThreshold = 5000; // 5 seconds
        setArtifacts((prevArtifacts) => {
          const updatedArtifacts = { ...prevArtifacts };
          const hasUpdates = false;

          Object.keys(updatedArtifacts).forEach((artifactId) => {
            const artifact = updatedArtifacts[artifactId];

            // Skip if not an update artifact
            if (!artifact || !artifact.isUpdate) {
              return;
            }

            const artifactAge = artifact.lastUpdateTime
              ? Date.now() - artifact.lastUpdateTime
              : Infinity;
            const isRecentUpdate = artifactAge < recentThreshold;

            if (!isRecentUpdate) {
              return;
            }
          });
          return hasUpdates ? updatedArtifacts : prevArtifacts;
        });
      }, 100); // 100ms delay to ensure React finishes processing streaming chunks

      // CRITICAL: Save pending selections FIRST (before content updates)
      // Use async IIFE to handle await
      (async () => {
        const sessionKeys = Object.keys(sessionStorage);
        const pendingSelectionKeys = sessionKeys.filter((key) =>
          key.startsWith('selection_pending_'),
        );

        for (const pendingSelectionKey of pendingSelectionKeys) {
          const pendingSelectionData = sessionStorage.getItem(pendingSelectionKey);
          if (!pendingSelectionData) continue;

          try {
            const pendingSelection = JSON.parse(pendingSelectionData);
            const messageId = pendingSelectionKey.replace('selection_pending_', '');
            const matchingArtifacts = _artifacts
              ? Object.values(_artifacts).filter(
                  (a: any) => a?.messageId === messageId && a?.isUpdate === true,
                )
              : [];

            if (matchingArtifacts.length > 0) {
              const latestUpdate = matchingArtifacts[matchingArtifacts.length - 1] as any;
              const artifactId = latestUpdate.id;
              if (!conversationId) {
                console.error('❌❌❌ [Artifact] CRITICAL: conversationId is MISSING!', {
                  artifactId,
                  messageId,
                  BLOCKER: 'Cannot save to database without conversationId',
                });
                continue;
              }

              // Save selection to cache and database
              const selectionSaveKeys: string[] = [artifactId];

              // Add to cache directly
              selectionSaveKeys.forEach((key) => {
                const selectionData = {
                  ...pendingSelection,
                  conversationId: conversationId,
                  timestamp: Date.now(),
                };
                artifactCache._selectionCache.set(key, selectionData);
              });

              // Save to localStorage
              artifactCache._saveToStorage();
              console.log('✅ [Artifact] Saved selection to localStorage');
              const primaryKey = selectionSaveKeys[0];
              try {
                const result = await artifactCache._syncToDatabase(
                  primaryKey,
                  'selection',
                  {
                    ...pendingSelection,
                    conversationId: conversationId,
                    timestamp: Date.now(),
                  },
                  {
                    conversationId: conversationId,
                    messageId: messageId,
                  },
                );

                console.log('✅✅✅ [Artifact] Selection SUCCESSFULLY saved to DATABASE:', {
                  artifactId: primaryKey,
                  conversationId: conversationId,
                  messageId: messageId,
                  success: !!result,
                  savedToMongoDB: true,
                  result: result,
                });

                // Clear from sessionStorage ONLY after successful database save
                sessionStorage.removeItem(pendingSelectionKey);
              } catch (error) {
                console.error('❌❌❌ [Artifact] Selection database save FAILED:', {
                  error,
                  artifactId: primaryKey,
                  conversationId,
                  messageId,
                  WILL_RETRY: 'Selection remains in sessionStorage for retry',
                });
              }
            }
          } catch (error) {
            console.error('❌ [Artifact] Failed to parse pending selection:', error);
          }
        }

        // NOW process content updates AFTER selections are saved
        if (pendingCacheUpdates.current.size > 0) {
          pendingCacheUpdates.current.forEach((update, artifactId) => {
            artifactCache.setContent(artifactId, update.content, {
              ...update.metadata,
              conversationId: update.conversationId,
              messageId: update.messageId,
            });
          });

          // Clear the pending updates
          pendingCacheUpdates.current.clear();
        }
        await artifactCache.flushPendingSyncs();
      })();
    }

    // Track previous streaming state
    lastIsSubmittingRef.current = artifactsContext.isSubmitting; // Changed from isStreaming
  }, [artifactsContext.isSubmitting, conversationId, setArtifacts, _artifacts]); // Changed dependency from isStreaming to isSubmitting

  const updateArtifact = useCallback(() => {
    let content = '';

    if ((node as any)?.data?.extractedCode) {
      content = (node as any).data.extractedCode;
    } else {
      content = extractContent(props.children);
    }

    if (content && lastSnippet.current) {
      // Check if this is just a re-render with EXACT SAME content
      if (content === lastSnippet.current) {
        return;
      }

      if (content.length <= lastSnippet.current.length) {
        return;
      }

      const lengthDiff = content.length - lastSnippet.current.length;
      if (lengthDiff < 5 && artifactsContext?.isSubmitting) {
        return;
      }
    }

    let finalContent = content;

    // 🔍 DEBUG: Log RAW incoming data AFTER deduplication check
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎯 [updateArtifact] ENTRY - RAW INCOMING DATA:', {
      timestamp: new Date().toISOString(),
      messageId,
      contentLength: content.length,
      contentPreview: content.substring(0, 300),
      lastSnippetLength: lastSnippet.current?.length || 0,
      isNewContent: content !== lastSnippet.current,
      isStreaming: artifactsContext?.isSubmitting,
    });
    console.log('═══════════════════════════════════════════════════════');

    // Skip if still no content
    if (!content || content.trim() === '') {
      return;
    }

    const hasTruncatedTags = /^[a-z]+\s+style=/im.test(content);
    if (hasTruncatedTags) {
      console.error('🚨 DETECTED TRUNCATED HTML TAGS - Content is corrupted!', {
        contentLength: content.length,
        firstLine: content.split('\n')[0],
        pattern: 'Tags missing opening bracket (e.g., "iv" instead of "<div")',
        REFUSING_TO_PROCESS: true,
      });
      return; // Abort - do not process corrupted content
    }

    const title = props.title ? props.title : defaultTitle;
    const type = props.type ?? defaultType;
    const identifier = props.identifier ?? defaultIdentifier;

    const shouldUpdate = isArtifactUpdateNode && identifier && identifier !== defaultIdentifier;
    if (shouldUpdate) {
      let existingArtifact = Object.values(_artifacts || {}).find(
        (a) => a && a.identifier === identifier,
      );

      if (!existingArtifact) {
        existingArtifact = Object.values(_artifacts || {}).find(
          (a) =>
            a &&
            typeof a.identifier === 'string' &&
            a.identifier.startsWith(identifier + '-update-'),
        );
      }

      if (existingArtifact) {
        const matchingArtifacts = Object.values(_artifacts || {}).filter(
          (a) =>
            a &&
            typeof a.identifier === 'string' &&
            (a.identifier === identifier || a.identifier.startsWith(identifier + '-update-')),
        );

        console.log('📋 [Matching Artifacts] Found for update chain:', {
          searchIdentifier: identifier,
          foundCount: matchingArtifacts.length,
          identifiers: matchingArtifacts.map((a) => a?.identifier),
          types: matchingArtifacts.map((a) => (a?.isUpdate ? 'UPDATE' : 'BASE')),
        });

        // Sort by lastUpdateTime to find the most recent
        matchingArtifacts.sort((a, b) => (b?.lastUpdateTime || 0) - (a?.lastUpdateTime || 0));
        const baseArtifact = matchingArtifacts.find((a) => a && !a.isUpdate) || existingArtifact;
        let baseContent = '';

        if (baseArtifact && !baseArtifact.isUpdate) {
          baseContent = baseArtifact.content || '';
        } else {
          baseContent = existingArtifact.content || '';
          console.log('⚠️ [Artifact Update] Using existing artifact as base:', {
            contentLength: baseContent.length,
          });
        }
        const matchingUpdates = _artifacts
          ? Object.values(_artifacts).filter(
              (a) =>
                a &&
                a.isUpdate &&
                a.identifier === existingArtifact.identifier &&
                a.messageId === messageId,
            )
          : [];

        // Sort by index descending to get the NEWEST update first
        matchingUpdates.sort((a, b) => (b?.index ?? 0) - (a?.index ?? 0));
        const existingUpdateForThisMessage = matchingUpdates[0];

        let updateArtifactKey: string;
        let updateIndex: number;
        let shouldSkipMerge = false;

        if (existingUpdateForThisMessage) {
          updateArtifactKey = existingUpdateForThisMessage.id;
          updateIndex = existingUpdateForThisMessage.index ?? 0;

          const snippetUnchanged = lastSnippet.current === content;
          shouldSkipMerge = snippetUnchanged;
        } else {
          // CREATE NEW artifact - this is a new update prompt
          const existingUpdates = _artifacts
            ? Object.values(_artifacts).filter(
                (a) => a && a.isUpdate && a.identifier === existingArtifact.identifier,
              )
            : [];

          updateIndex = existingUpdates.length;

          updateArtifactKey = `${existingArtifact.identifier}_update${updateIndex}_${type}_${title}`
            .replace(/\s+/g, '_')
            .replace(/\//g, '-')
            .toLowerCase();
        }

        const _isStreaming = artifactsContext?.isSubmitting;
        let noMergeHappened = false;
        const _wasTruncated =
          content.length > 0 && finalContent.length < baseContent.length + content.length;

        if (shouldSkipMerge && existingUpdateForThisMessage) {
          finalContent = existingUpdateForThisMessage.content || content;
        } else {
          finalContent = applyPartialUpdate(
            baseContent, // ALWAYS use ORIGINAL base artifact content
            content, // NEW snippet from LLM
            updateArtifactKey, // Use UPDATE artifact key for selection lookup
            Object.keys(_artifacts || {}).length,
            _artifacts || undefined,
          );
          lastSnippet.current = content;
        }

        if (!_isStreaming) {
          noMergeHappened = finalContent === baseContent;
        }

        if (noMergeHappened) {
          console.warn('⚠️ [Artifact Update] No merge happened - selection context missing!', {
            baseContentLength: baseContent.length,
            snippetLength: content.length,
            DECISION: 'Will display SNIPPET in update artifact, keep base unchanged',
          });

          finalContent = content;
        }

        if (!finalContent || finalContent.trim() === '') {
          console.error(
            '⚠️ applyPartialUpdate returned empty content! Using baseContent as fallback',
          );
          finalContent = baseContent || content;
        }

        lastSnippet.current = content;
        lastContent.current = content;

        const updateArtifact: Artifact = {
          id: updateArtifactKey,
          identifier: existingArtifact.identifier,
          title: existingArtifact.title,
          type: existingArtifact.type,
          content: content,
          messageId,
          index: updateIndex,
          lastUpdateTime: Date.now(),
          isUpdate: true,
        };

        const pendingSelectionKey = `selection_pending_${messageId}`;
        const pendingSelectionData = sessionStorage.getItem(pendingSelectionKey);
        let pendingSelection: any = null;
        if (pendingSelectionData) {
          try {
            pendingSelection = JSON.parse(pendingSelectionData);
            sessionStorage.removeItem(pendingSelectionKey);
            const selectionSaveKeys: string[] = [updateArtifact.id];

            // Add base identifier if available
            if (existingArtifact.identifier) {
              selectionSaveKeys.push(existingArtifact.identifier);
            }

            // If there's a base artifact, also save with its ID
            if (baseArtifact?.id) {
              selectionSaveKeys.push(baseArtifact.id);
            }

            selectionSaveKeys.forEach((key, index) => {
              const selectionData = {
                ...pendingSelection,
                conversationId: conversationId || undefined,
                timestamp: Date.now(),
              };

              // Add to cache directly (bypass setSelection to avoid multiple storage saves)
              artifactCache._selectionCache.set(key, selectionData);
            });

            artifactCache._saveToStorage();
            if (conversationId) {
              const primaryKey = selectionSaveKeys[0];
              artifactCache
                ._syncToDatabase(
                  primaryKey,
                  'selection',
                  {
                    ...pendingSelection,
                    conversationId: conversationId,
                    timestamp: Date.now(),
                  },
                  {
                    conversationId: conversationId,
                    messageId: messageId,
                  },
                )
                .then((result) => {
                  console.log('✅ [Artifact] Database sync completed for primary selection key:', {
                    primaryKey,
                    success: !!result,
                    totalKeysInCache: selectionSaveKeys.length,
                    conversationId: conversationId,
                  });
                })
                .catch((error) => {
                  console.error('❌ [Artifact] Database sync failed:', error);
                });
            } else {
              console.error(
                '❌❌❌ [Artifact] CANNOT SAVE TO DATABASE - conversationId is missing!',
                {
                  primaryKey: selectionSaveKeys[0],
                  messageId: messageId,
                  CRITICAL_ISSUE: 'Selection saved to localStorage but NOT to database',
                  IMPACT: 'Will work in current session but LOST on page refresh',
                  FIX_NEEDED: 'Ensure conversationId is available before saving selection',
                },
              );
            }
          } catch (error) {
            console.error('❌ [Artifact] Failed to parse pending selection:', error);
          }
        } else {
          console.warn('⚠️ [Artifact] No pending selection found in sessionStorage', {
            expectedKey: pendingSelectionKey,
            messageId,
            POSSIBLE_ISSUE:
              'Selection component may not have run yet, or selection was not provided',
          });
        }

        // Get all selection entries from cache
        const allSelectionEntries = Array.from(artifactCache._selectionCache.entries());
        // Strategy 1: Try to find by messageId (this will work if selection was just made)
        const matchingByMessageId = allSelectionEntries
          .filter(([_key, val]) => val.artifactMessageId === messageId)
          .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

        // Strategy 2: Find the MOST RECENT selection for this identifier (timestamp-based)
        const matchingByIdentifier = allSelectionEntries
          .filter(([_key, _val]) => {
            // Match by identifier (base part of key)
            const keyLower = _key.toLowerCase();
            const identifier = existingArtifact.identifier || '';
            return keyLower.startsWith(identifier.toLowerCase());
          })
          .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

        // Use messageId match if found, otherwise fall back to most recent by identifier
        const matchingSelections =
          matchingByMessageId.length > 0 ? matchingByMessageId : matchingByIdentifier;
        // This ensures the LLM's explicit location information is used first
        let sourceSelectionContext: any = null;
        if (pendingSelection) {
          sourceSelectionContext = pendingSelection;
        } else if (matchingSelections.length > 0) {
          sourceSelectionContext = matchingSelections[0][1];
        }

        if (sourceSelectionContext) {
          const selectionWithCurrentContent = {
            ...sourceSelectionContext,
            updatedText: content,
            artifactId: updateArtifact.id,
            source: sourceSelectionContext.source || 'llm', // Default to 'llm' if not set (LLM-provided coordinates)
          };
          artifactCache.setSelection(updateArtifact.id, selectionWithCurrentContent, {
            conversationId: conversationId || undefined,
            messageId: messageId || undefined,
          });
        }
        if (!noMergeHappened) {
          if (!conversationId) {
            console.error('❌❌❌ [Artifact] Queuing update WITHOUT conversationId!', {
              artifactId: updateArtifact.id,
              conversationIdFromContext: artifactsContext.conversationId,
              conversationIdFromURL: location.pathname.match(/\/c\/([^/]+)/)?.[1],
              pathname: location.pathname,
              BLOCKER: 'This will fail to save to database!',
            });
          }

          let contentToSave = finalContent;
          const sampleSize = Math.min(500, Math.floor(contentToSave.length / 3));
          const firstChunk = contentToSave.substring(0, sampleSize);
          const isDuplicated = contentToSave.indexOf(firstChunk, sampleSize) !== -1;

          if (isDuplicated) {
            const duplicateStartIndex = contentToSave.indexOf(firstChunk, sampleSize);
            console.error(
              '🚨🚨🚨 [DUPLICATION DETECTED] Preventing duplicated content from being saved to cache!',
              {
                artifactId: updateArtifact.id,
                contentLength: contentToSave.length,
                duplicateStartsAt: duplicateStartIndex,
                sampleSize,
                contentPreview: contentToSave.substring(0, 300),
                FIXING: 'Saving only first occurrence',
              },
            );

            // Extract only the first occurrence
            contentToSave = contentToSave.substring(0, duplicateStartIndex);
          }

          pendingCacheUpdates.current.set(updateArtifact.id, {
            content: contentToSave,
            conversationId: conversationId ?? undefined,
            messageId: messageId,
            metadata: {
              title: updateArtifact.title,
              type: updateArtifact.type,
              identifier: updateArtifact.identifier,
              source: 'directive',
            },
          });
        } else {
          console.warn('⚠️ [Artifact] NOT queuing cache save for UPDATE - no merge happened!', {
            updateArtifactId: updateArtifact.id,
            snippetLength: content.length,
            REASON: 'Would save snippet instead of full document - cache must have full content',
          });
        }

        if (existingArtifact && existingArtifact.id && !noMergeHappened) {
          let baseContentToSave = finalContent;
          const baseSampleSize = Math.min(500, Math.floor(baseContentToSave.length / 3));
          const baseFirstChunk = baseContentToSave.substring(0, baseSampleSize);
          const baseIsDuplicated = baseContentToSave.indexOf(baseFirstChunk, baseSampleSize) !== -1;

          if (baseIsDuplicated) {
            const baseDuplicateStartIndex = baseContentToSave.indexOf(
              baseFirstChunk,
              baseSampleSize,
            );
            console.error(
              '🚨🚨🚨 [DUPLICATION DETECTED] Preventing duplicated content from being saved to BASE cache!',
              {
                artifactId: existingArtifact.id,
                contentLength: baseContentToSave.length,
                duplicateStartsAt: baseDuplicateStartIndex,
                sampleSize: baseSampleSize,
                FIXING: 'Saving only first occurrence',
              },
            );

            baseContentToSave = baseContentToSave.substring(0, baseDuplicateStartIndex);
          }

          pendingCacheUpdates.current.set(existingArtifact.id, {
            content: baseContentToSave,
            conversationId: conversationId ?? undefined,
            messageId: messageId,
            metadata: {
              title: existingArtifact.title,
              type: existingArtifact.type,
              identifier: existingArtifact.identifier,
              source: 'directive',
            },
          });
          console.log('📝 [Artifact] Queued cache save for BASE artifact:', {
            artifactId: existingArtifact.id,
            contentLength: baseContentToSave.length,
            contentPreview: finalContent.substring(0, 200),
            pendingCount: pendingCacheUpdates.current.size,
          });
        } else if (noMergeHappened) {
          console.warn(
            '⚠️ [Artifact] NOT saving snippet to base artifact cache - no merge happened!',
            {
              baseArtifactId: existingArtifact?.id,
              snippetLength: finalContent.length,
              REASON: 'Selection context missing - base must stay unchanged',
            },
          );
        }

        const displayArtifact = {
          ...updateArtifact,
          content: finalContent,
          isMerged: !artifactsContext.isSubmitting && !noMergeHappened,
        };
        if (!shouldSkipMerge) {
          setArtifacts((prevArtifacts) => {
            return {
              ...prevArtifacts,
              [updateArtifactKey]: updateArtifact,
            };
          });
        }

        if (!shouldSkipMerge) {
          setArtifact(displayArtifact); // Set local state with merged content
          setCurrentArtifactId(updateArtifact.id);
        }

        setTimeout(() => {
          setArtifacts((currentArtifacts) => {
            if (!currentArtifacts) {
              console.error('❌ [VERIFICATION] artifacts state is null!');
              return currentArtifacts;
            }
            return currentArtifacts; // Don't modify, just inspect
          });
        }, 100);

        _setRefreshTrigger((prev) => prev + 1);
        setArtifactsVisible(true);
        lastContent.current = content; // Track incoming snippet for deduplication

        return;
      } else {
        console.warn('⚠️ No existing artifact found for identifier:', identifier);
        console.warn('⚠️ Creating update artifact without base (base may arrive later)');
        let updateIndexWithoutBase = 0;
        let updateArtifactKey = '';

        setArtifacts((prevArtifacts) => {
          // Calculate the update index by counting existing updates with this identifier IN CURRENT STATE
          const existingUpdatesWithoutBase = prevArtifacts
            ? Object.values(prevArtifacts).filter(
                (a) => a && a.isUpdate && a.identifier === identifier,
              )
            : [];
          updateIndexWithoutBase = existingUpdatesWithoutBase.length;
          console.log('index 1.3', updateIndexWithoutBase);
          updateArtifactKey = `${identifier}_update${updateIndexWithoutBase}_${type}_${title}`
            .replace(/\s+/g, '_')
            .replace(/\//g, '-')
            .toLowerCase();

          // Don't update state yet - just calculate the index
          return prevArtifacts;
        });

        const updateArtifact: Artifact = {
          id: updateArtifactKey,
          identifier: identifier,
          title: title,
          type: type,
          content: content, // Store raw content since we have no base to merge with
          messageId,
          conversationId: conversationId ?? undefined,
          index: updateIndexWithoutBase,
          lastUpdateTime: Date.now(),
          isUpdate: true, // Mark as update even without base
        };
        console.warn(
          '⚠️ [Artifact] Update created without base - NOT queueing snippet-only cache save',
        );
        console.warn('⚠️ [Artifact] Will wait for base artifact to arrive for proper merging');

        setArtifacts((prevArtifacts) => ({
          ...prevArtifacts,
          [updateArtifactKey]: updateArtifact,
        }));

        setArtifact(updateArtifact);
        setCurrentArtifactId(updateArtifact.id);
        setArtifactsVisible(true);

        lastContent.current = content;
        return;
      }
    }
    if (isArtifactUpdateNode) {
      console.error('🚨🚨🚨 [CRITICAL BUG] artifactupdate node reached regular artifact path!', {
        isArtifactUpdateNode,
        identifier,
        shouldUpdateWas: shouldUpdate,
        REFUSING_TO_CREATE_WITH_MESSAGEID: true,
      });
      return; // Abort - this should never happen
    }
    const artifactKey = `${identifier}_${type}_${title}_${messageId}`
      .replace(/\s+/g, '_')
      .replace(/\//g, '-')
      .toLowerCase();

    const now = Date.now();
    if (artifactKey === `${defaultIdentifier}_${defaultType}_${defaultTitle}_${messageId}`) {
      console.log('⚠️ Default artifact key detected, skipping artifact creation.');
      return;
    }
    // Determine the correct index for this artifact (increment for each update)
    let newIndex = 0;

    if (_artifacts && identifier) {
      const relatedArtifacts = Object.values(_artifacts).filter(
        (a) => a && a.identifier === identifier,
      );
      const maxIndex = relatedArtifacts.length
        ? Math.max(...relatedArtifacts.map((a) => (a && a.index != null ? a.index : 0)))
        : 0;
      newIndex = maxIndex + 1;
    }
    const currentArtifact: Artifact = {
      id: artifactKey,
      identifier,
      title,
      type,
      content: content,
      messageId,
      conversationId: conversationId ?? undefined,
      index: newIndex,
      lastUpdateTime: now,
      isUpdate: false,
    };

    setArtifactsVisible(true);

    if (!location.pathname.includes('/c/')) {
      setArtifact(currentArtifact);
      setCurrentArtifactId(currentArtifact.id);
      return;
    }

    setArtifacts((prevArtifacts) => {
      const existingArtifact = prevArtifacts?.[artifactKey];

      if (existingArtifact) {
        console.log('🔄 Updating existing base artifact with new streaming content:', {
          artifactKey,
          previousLength: existingArtifact.content?.length || 0,
          newLength: content.length,
          willUpdate: true,
          CRITICAL: 'This OVERWRITES the existing artifact - make sure messageId is unique!',
          existingMessageId: existingArtifact.messageId,
          newMessageId: messageId,
          sameMessage: existingArtifact.messageId === messageId,
        });
      } else {
        console.log('✅ Creating NEW base artifact (no existing artifact found):', {
          artifactKey,
          messageId,
          contentLength: content.length,
          CRITICAL: 'This is a brand new independent artifact',
        });
      }
      return {
        ...prevArtifacts,
        [artifactKey]: currentArtifact,
      };
    });

    setArtifact(currentArtifact);
    setCurrentArtifactId(currentArtifact.id);
    setArtifactsVisible(true);

    pendingCacheUpdates.current.set(currentArtifact.id, {
      content: currentArtifact.content || '',
      conversationId: conversationId ?? undefined,
      messageId: messageId,
      metadata: {
        title: currentArtifact.title,
        type: currentArtifact.type,
        identifier: currentArtifact.identifier,
        source: 'directive',
      },
    });

    // Update lastContent to track this version
    lastContent.current = content;
  }, [
    messageId,
    node,
    props.children,
    props.title,
    props.type,
    props.identifier,
    artifactsContext,
    isArtifactUpdateNode,
    _artifacts,
    location.pathname,
    setArtifacts,
    setCurrentArtifactId,
    setArtifactsVisible,
    _setRefreshTrigger,
    conversationId,
  ]);

  // Add this ref at the top-level of the component, not inside useEffect
  const lastProcessedMessageId = useRef<string | null>(null);
  const lastReconstructedArtifactId = useRef<string | null>(null);

  // --- NEW: Update local artifact state when selected artifact changes ---
  useEffect(() => {
    if (!_currentArtifactId || !_artifacts || !_artifacts[_currentArtifactId]) {
      return;
    }
    if (!artifact) {
      return;
    }

    if (artifact.id !== _currentArtifactId) {
      return;
    }

    const loadedArtifact = _artifacts[_currentArtifactId];
    const isPageRefresh =
      loadedArtifact.lastUpdateTime && Date.now() - loadedArtifact.lastUpdateTime > 2000;

    if (isPageRefresh && conversationId) {
      // Check if cache has been loaded by seeing if it has any entries
      const cacheSize = artifactCache._selectionCache.size;

      // If cache is empty but we're on page refresh, WAIT for cache to load
      if (cacheSize === 0) {
        return;
      }
    }

    const cachedContent = artifactCache.getContent(loadedArtifact.id);
    if (cachedContent && cachedContent.content && cachedContent.content.trim() !== '') {
      const cachedArtifact = {
        ...loadedArtifact,
        content: cachedContent.content,
        isMerged: true,
      };
      setArtifact(cachedArtifact);
      setCurrentArtifactId(cachedArtifact.id);
      // DO NOT call setArtifacts here - it will trigger this useEffect again!
      lastReconstructedArtifactId.current = _currentArtifactId;
      return;
    }

    if (loadedArtifact.isUpdate) {
      // STEP 1: Check if we have cached merged content (this is the FASTEST path)
      const cachedMergedContent = artifactCache.getContent(loadedArtifact.id);
      if (
        cachedMergedContent &&
        cachedMergedContent.content &&
        cachedMergedContent.content.trim() !== ''
      ) {
        const cachedArtifact = {
          ...loadedArtifact,
          content: cachedMergedContent.content,
          isMerged: true,
        };
        setArtifact(cachedArtifact);
        setCurrentArtifactId(cachedArtifact.id);
        // DO NOT call setArtifacts - causes infinite loop!
        lastReconstructedArtifactId.current = _currentArtifactId;
        return;
      }

      const isCorrupted =
        loadedArtifact.content &&
        (loadedArtifact.content.startsWith('iv style') ||
          !!loadedArtifact.content.match(/^[a-z]{1,3}\s+style/));

      // Content is "complete" if it's longer than 50 chars and not corrupted
      // This works for ANY artifact format (HTML, React, Python, SVG, etc.)
      const hasCompleteContent =
        loadedArtifact.content && loadedArtifact.content.trim().length > 50 && !isCorrupted;

      const isOldArtifact =
        loadedArtifact.lastUpdateTime && Date.now() - loadedArtifact.lastUpdateTime > 5000;

      if (isOldArtifact) {
        const baseArtifact = Object.values(_artifacts).find(
          (a) => a && !a.isUpdate && a.identifier === loadedArtifact.identifier,
        );

        if (baseArtifact && baseArtifact.content && baseArtifact.content.length > 100) {
          // Use base artifact directly - it already has the final merged content
          setArtifact(baseArtifact);
          setCurrentArtifactId(baseArtifact.id);
          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        }
      }

      if (!hasCompleteContent) {
        console.warn(
          '⚠️ [Cache Reconstruction] Loaded update artifact has INCOMPLETE/CORRUPTED CONTENT!',
          {
            loadedArtifactId: loadedArtifact.id,
            hasContent: !!loadedArtifact.content,
            contentLength: loadedArtifact.content?.length || 0,
            contentPreview: loadedArtifact.content?.substring(0, 100) || 'EMPTY',
            isCorrupted: isCorrupted,
            hasCompleteContent: hasCompleteContent,
            willReconstruct: true,
          },
        );

        // STEP 1: Try to find the base artifact
        const baseArtifact = Object.values(_artifacts).find(
          (a) => a && !a.isUpdate && a.identifier === loadedArtifact.identifier,
        );

        if (baseArtifact && baseArtifact.content) {
          // STEP 2: Try to get selection context to apply precise update
          const selectionContext = artifactCache.getSelection(loadedArtifact.id);
          if (
            selectionContext &&
            typeof selectionContext.startLine === 'number' &&
            typeof selectionContext.endLine === 'number' &&
            selectionContext.originalText
          ) {
            // Apply the update with selection context
            const mergedContent = applyAllPartialUpdates(
              baseArtifact.content,
              _artifacts,
              loadedArtifact.id,
              false, // Not streaming
              conversationId,
            );

            if (mergedContent && mergedContent.trim() !== '') {
              const baseArtifactWithUpdates = {
                ...baseArtifact,
                content: mergedContent,
                isMerged: true,
              };

              // Save to cache for BOTH base and update
              artifactCache.setContent(baseArtifact.id, mergedContent, {
                title: baseArtifact.title,
                type: baseArtifact.type,
                identifier: baseArtifact.identifier,
                source: 'directive',
              });

              artifactCache.setContent(loadedArtifact.id, mergedContent, {
                title: loadedArtifact.title,
                type: loadedArtifact.type,
                identifier: loadedArtifact.identifier,
                source: 'directive',
              });

              // Set BASE artifact as current (shows complete merged result)
              setArtifact(baseArtifactWithUpdates);
              setCurrentArtifactId(baseArtifact.id);
              lastReconstructedArtifactId.current = _currentArtifactId;
              return;
            }
          }

          const baseArtifactFallback = {
            ...baseArtifact,
            content: baseArtifact.content,
          };

          setArtifact(baseArtifactFallback);
          setCurrentArtifactId(baseArtifact.id);

          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        } else {
          console.error('❌ [Cache Reconstruction] No base artifact found - cannot reconstruct!');
          // Show empty state - better than crashing
          setArtifact(loadedArtifact);
          setCurrentArtifactId(loadedArtifact.id);

          // Mark as processed even if reconstruction failed
          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        }
      }

      if (!loadedArtifact.isUpdate) {
        setArtifact(loadedArtifact);
        setCurrentArtifactId(loadedArtifact.id);
        lastReconstructedArtifactId.current = _currentArtifactId;
        return;
      }

      // Find the base artifact (non-update) with the same identifier
      const baseArtifact = Object.values(_artifacts).find(
        (a) => a && !a.isUpdate && a.identifier === loadedArtifact.identifier,
      );

      if (baseArtifact && baseArtifact.content) {
        // Get the selection context for this update artifact
        const selectionContext = artifactCache.getSelection(loadedArtifact.id);

        if (
          selectionContext &&
          typeof selectionContext.startLine === 'number' &&
          typeof selectionContext.endLine === 'number' &&
          typeof selectionContext.startColumn === 'number' &&
          typeof selectionContext.endColumn === 'number' &&
          selectionContext.originalText
        ) {
          // Verify that the originalText matches the current text at the specified location
          const baseLines = baseArtifact.content.split('\n');
          const { startLine, endLine, startColumn, endColumn, originalText } = selectionContext;

          // Extract the text at the specified location
          let actualText = '';
          if (startLine === endLine) {
            // Single line selection
            actualText = baseLines[startLine]?.slice(startColumn, endColumn) || '';
          } else {
            // Multi-line selection
            const firstLinePart = baseLines[startLine]?.slice(startColumn) || '';
            const lastLinePart = baseLines[endLine]?.slice(0, endColumn) || '';
            const middleLines = baseLines.slice(startLine + 1, endLine);
            actualText = [firstLinePart, ...middleLines, lastLinePart].join('\n');
          }

          if (actualText === originalText) {
            const isFullDoc = (loaded: string, base: string) => {
              // If loaded content is significantly larger than base (>80% size difference),
              // it's likely already merged. Also check if it's not identical to base.
              const sizeDiff = loaded.length / Math.max(base.length, 1);
              return sizeDiff > 1.8 && loaded !== base;
            };
            const loadedContentIsFullDoc = isFullDoc(
              loadedArtifact.content || '',
              baseArtifact.content || '',
            );
            const loadedContentIsSameAsBase = loadedArtifact.content === baseArtifact.content;
            // If loaded content is already a full document and different from base,
            // it's probably already merged - use it directly
            if (loadedContentIsFullDoc && !loadedContentIsSameAsBase) {
              const reconstructedArtifact = {
                ...loadedArtifact,
                content: loadedArtifact.content,
              };

              setArtifact(reconstructedArtifact);
              setCurrentArtifactId(reconstructedArtifact.id);
              setArtifacts((prev) => ({
                ...prev,
                [loadedArtifact.id]: reconstructedArtifact,
              }));

              lastReconstructedArtifactId.current = _currentArtifactId;
              return;
            }

            // Otherwise, apply the merge (content is a snippet)
            const mergedContent = applyPartialUpdate(
              baseArtifact.content,
              loadedArtifact.content || '',
              loadedArtifact.id,
              Object.keys(_artifacts).length,
              _artifacts,
            );

            if (mergedContent && mergedContent !== baseArtifact.content) {
              const reconstructedArtifact = {
                ...loadedArtifact,
                content: mergedContent,
              };

              setArtifact(reconstructedArtifact);
              setCurrentArtifactId(reconstructedArtifact.id);
              setArtifacts((prev) => ({
                ...prev,
                [loadedArtifact.id]: reconstructedArtifact,
              }));

              // Save the merged content to cache
              artifactCache.setContent(loadedArtifact.id, mergedContent, {
                title: loadedArtifact.title,
                type: loadedArtifact.type,
                identifier: loadedArtifact.identifier,
                source: 'directive',
              });

              lastReconstructedArtifactId.current = _currentArtifactId;
              return;
            }
          }
        }

        // Fallback: Use applyAllPartialUpdates to rebuild complete state
        const mergedContent = applyAllPartialUpdates(
          baseArtifact.content,
          _artifacts,
          loadedArtifact.id,
          false,
          conversationId,
        );
        if (!mergedContent) {
          console.error('❌ [Cache Reconstruction] Merge failed - mergedContent is null/empty!', {
            baseContentLength: baseArtifact.content.length,
            loadedArtifactId: loadedArtifact.id,
            loadedContent: loadedArtifact.content?.substring(0, 100),
          });
          // Fallback: use the loaded artifact's raw content if available
          // or the base artifact content as last resort
          const fallbackContent = loadedArtifact.content || baseArtifact.content;
          const reconstructedArtifact = {
            ...loadedArtifact,
            content: fallbackContent,
          };
          setArtifact(reconstructedArtifact);
          setCurrentArtifactId(reconstructedArtifact.id);
          // DO NOT call setArtifacts - causes infinite loop!

          // Mark as processed
          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        }

        // This ensures users see the complete document with all updates applied
        const baseArtifactWithUpdates = {
          ...baseArtifact,
          content: mergedContent,
          isMerged: true,
        };

        // Save merged content to BOTH base and update caches
        artifactCache.setContent(baseArtifact.id, mergedContent, {
          title: baseArtifact.title,
          type: baseArtifact.type,
          identifier: baseArtifact.identifier,
          source: 'directive',
        });

        artifactCache.setContent(loadedArtifact.id, mergedContent, {
          title: loadedArtifact.title,
          type: loadedArtifact.type,
          identifier: loadedArtifact.identifier,
          source: 'directive',
        });

        setArtifact(baseArtifactWithUpdates);
        setCurrentArtifactId(baseArtifact.id);

        // Mark this artifact as processed to prevent re-processing
        lastReconstructedArtifactId.current = _currentArtifactId;
        return;
      }
    }

    setArtifact(loadedArtifact);
    setCurrentArtifactId(loadedArtifact.id);
    lastReconstructedArtifactId.current = _currentArtifactId;
  }, [
    _currentArtifactId,
    _artifacts,
    setArtifacts,
    conversationId,
    setCurrentArtifactId,
    artifact,
  ]);

  useEffect(() => {
    // Compose a unique key for the artifact update
    const updateKey = `${props.identifier}_${props.type}_${props.title}_${messageId}`;
    const extracted = extractNodes(props.children);
    let content = '';

    // Prioritize extractedNodes (from markdown plugin) over extractContent
    if (typeof extracted === 'string') {
      content = extracted;
    } else if (Array.isArray(extracted)) {
      // Ensure all elements are strings before joining
      if ((extracted as unknown[]).every((el) => typeof el === 'string')) {
        content = (extracted as string[]).join('');
      } else {
        content = String(extracted);
      }
    } else if (extracted !== undefined && extracted !== null) {
      content = String(extracted);
    }

    // Only fall back to extractContent if extractNodes didn't yield anything
    if (!content) {
      content = extractContent(props.children);
    }
    const hasContent = content && content.trim() !== '';
    const shouldProcess = isArtifactUpdateNode || hasContent;

    const isStreaming = artifactsContext.isSubmitting;
    const wasStreaming = lastIsSubmittingRef.current;
    const streamingJustCompleted = wasStreaming && !isStreaming;

    const shouldUpdate =
      shouldProcess &&
      (isArtifactUpdateNode
        ? // For updates: Process during streaming AND after streaming completes
          (streamingJustCompleted && hasContent) ||
          // During streaming: Process if content changed
          (isStreaming && lastContent.current !== content && hasContent) ||
          // After streaming: Process if content changed
          (!isStreaming && lastContent.current !== content && hasContent) ||
          // First time seeing content (lastContent not set)
          (!lastContent.current && hasContent) ||
          // After page refresh - we have content but haven't processed this message yet
          (hasContent && lastProcessedMessageId.current !== messageId)
        : // For regular artifacts: trigger on key/message change OR content change
          lastUpdateKey.current !== updateKey ||
          lastContent.current !== content ||
          lastProcessedMessageId.current !== messageId);

    if (shouldUpdate) {
      lastUpdateKey.current = updateKey;
      lastProcessedMessageId.current = messageId;
      resetCounter();
      updateArtifact();
    }
  }, [
    props.identifier,
    props.type,
    props.title,
    messageId,
    props.children,
    updateArtifact,
    resetCounter,
    _currentArtifactId,
    setCurrentArtifactId,
    isArtifactUpdateNode,
    artifact?.id,
    artifactsContext.isSubmitting,
  ]);

  // --- Set merged artifact state after merge (in effect, not render) ---
  useEffect(() => {
    // Only sync if:
    // - This is an update node
    // - displayArtifact and artifact exist and have the same id
    // - The artifact in global state (_artifacts) is out of sync with the merged content
    if (
      isArtifactUpdateNode &&
      displayArtifact &&
      artifact &&
      displayArtifact.id === artifact.id &&
      _artifacts?.[displayArtifact.id]?.content !== displayArtifact.content
    ) {
      setArtifacts((prevArtifacts) => {
        if (!prevArtifacts) return {};
        if (prevArtifacts?.[displayArtifact.id]?.content === displayArtifact.content)
          return prevArtifacts;
        return {
          ...prevArtifacts,
          [displayArtifact.id]: displayArtifact,
        };
      });
    }
  }, [displayArtifact, artifact, isArtifactUpdateNode, setArtifacts, _artifacts]);

  return <ArtifactButton artifact={artifact} />;
}

// Selection component to parse and save selection context BEFORE artifact updates
function SelectionComponent({
  node,
  selectionText: propsSelectionText,
}: {
  node: unknown;
  children?: React.ReactNode;
  selectionText?: string;
}) {
  const { messageId } = useMessageContext();
  const artifactsContext = useArtifactsContext();
  const location = useLocation();
  const [_artifacts] = useRecoilState(artifactsState);

  const conversationId = React.useMemo(() => {
    // Strategy 1: From artifacts context (most reliable)
    if (artifactsContext.conversationId) {
      return artifactsContext.conversationId;
    }

    // Strategy 2: From URL pathname
    const urlMatch = location.pathname.match(/\/c\/([^/]+)/);
    if (urlMatch && urlMatch[1]) {
      console.log('📍 [Selection] Got conversationId from URL:', urlMatch[1]);
      return urlMatch[1];
    }

    // Strategy 3: From URL search params
    const searchParams = new URLSearchParams(location.search);
    const searchConvId = searchParams.get('conversationId');
    if (searchConvId) {
      return searchConvId;
    }

    // Strategy 4: Try to get from any existing artifact in the current message
    const artifactsArray = _artifacts ? Object.values(_artifacts) : [];
    const recentArtifact = artifactsArray.find((a) => a?.messageId === messageId);
    if (recentArtifact && (recentArtifact as any).conversationId) {
      return (recentArtifact as any).conversationId;
    }
    return null;
  }, [artifactsContext.conversationId, location.pathname, location.search, messageId, _artifacts]);

  useEffect(() => {
    const selectionText = propsSelectionText || (node as any)?.data?.selectionText || '';

    if (!selectionText) {
      console.warn('⚠️ [Selection] No selection text found', {
        propsSelectionText,
        nodeData: (node as any)?.data,
        fullNode: node,
        CRITICAL: 'Neither props.selectionText nor node.data.selectionText available!',
      });
      return;
    }
    let originalTextMatch = selectionText.match(/-?\s*originalText:\s*"([\s\S]*?)"\s*(?:\n|$)/);
    if (!originalTextMatch) {
      // Fallback 1: More greedy - match everything up to the quote before startLine/endLine
      originalTextMatch = selectionText.match(
        /-?\s*originalText:\s*"([\s\S]+?)"\s*(?=\n\w+:|\n$|$)/,
      );
    }
    if (!originalTextMatch) {
      // Fallback 2: Try without quotes for single-word values
      originalTextMatch = selectionText.match(/-?\s*originalText:\s*([^\n]+)/);
    }

    const startLineMatch = selectionText.match(/-?\s*startLine:\s*(\d+)/);
    const endLineMatch = selectionText.match(/-?\s*endLine:\s*(\d+)/);
    const startColumnMatch = selectionText.match(/-?\s*startColumn:\s*(\d+)/);
    const endColumnMatch = selectionText.match(/-?\s*endColumn:\s*(\d+)/);

    if (!startLineMatch || !endLineMatch) {
      return;
    }

    // startColumn defaults to 0 (start of line)
    // endColumn defaults to 0 (will be adjusted to end of line in applyPartialUpdate)
    const startColumn = startColumnMatch ? parseInt(startColumnMatch[1], 10) : 0;
    const endColumn = endColumnMatch ? parseInt(endColumnMatch[1], 10) : 0;
    const selectionContext = {
      originalText: originalTextMatch ? originalTextMatch[1] : '',
      startLine: parseInt(startLineMatch[1], 10),
      endLine: parseInt(endLineMatch[1], 10),
      startColumn, // Use the variable with default value (already computed above)
      endColumn, // Use the variable with default value (already computed above)
      artifactMessageId: messageId,
      fileKey: `artifact_${messageId}`, // Required field for ArtifactSelectionContext
    };

    // Strategy: Use sessionStorage with messageId as key
    // The Artifact component will read this when processing artifactupdate
    const storageKey = `selection_pending_${messageId}`;
    sessionStorage.setItem(storageKey, JSON.stringify(selectionContext));
  }, [node, messageId, conversationId, _artifacts, propsSelectionText]);

  // Don't render anything visible
  return null;
}

export const ArtifactUpdate = Artifact;
export const Selection = SelectionComponent;
