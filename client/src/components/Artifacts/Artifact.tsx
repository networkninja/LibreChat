import React, { useEffect, useCallback, useRef, useState } from 'react';
import { visit } from 'unist-util-visit';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext, useArtifactsContext } from '~/Providers';
import { logger, extractNodes, extractContent } from '~/utils';
import { artifactsState } from '~/store/artifacts';
import ArtifactButton from './ArtifactButton';
import { artifactCache } from './artifactCache';
import store from '~/store';
import { applyPartialUpdate, applyAllPartialUpdates } from '~/hooks/Artifacts/useArtifactUtlis';
import { artifactRefreshTriggerState } from '~/hooks/Artifacts/useArtifacts';

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
        console.log('🎯 [artifactPlugin] DETECTED :::selection::: directive!', {
          nodeType: node.type,
          nodeName: node.name,
          hasChildren: Array.isArray(node.children),
          childCount: Array.isArray(node.children) ? node.children.length : 0,
          fullNode: JSON.stringify(node, null, 2),
        });

        // CRITICAL: Recursively extract ALL text from nested children
        // The selection content can be in various node structures depending on how markdown is parsed
        const extractTextRecursive = (n: any): string => {
          let text = '';

          if (n.type === 'text') {
            text += n.value;
          }

          if (Array.isArray(n.children)) {
            n.children.forEach((child: any) => {
              text += extractTextRecursive(child);
              // Add newlines between paragraphs for proper formatting
              if (child.type === 'paragraph' || child.type === 'break') {
                text += '\n';
              }
            });
          }

          return text;
        };

        const selectionText = extractTextRecursive(node);

        console.log('📍 [artifactPlugin] Extracted selection text:', {
          length: selectionText.length,
          preview: selectionText.substring(0, 300),
          fullText: selectionText,
          CRITICAL: 'This text will be parsed by SelectionComponent',
        });

        // CRITICAL: Transform the directive node into an element node that ReactMarkdown will render
        // Without this, ReactMarkdown won't know to render our Selection component
        if (!node.data) {
          node.data = {};
        }
        node.data.selectionText = selectionText;
        node.data.hName = 'selection'; // This tells ReactMarkdown to use the 'selection' component
        node.data.hProperties = node.data.hProperties || {};

        console.log('✅ [artifactPlugin] Transformed node for Selection component:', {
          nodeType: node.type,
          nodeName: node.name,
          hName: node.data.hName,
          hasSelectionText: !!node.data.selectionText,
          CRITICAL: 'ReactMarkdown will now render <Selection node={...} />',
        });

        // CRITICAL FIX: Pass selectionText as hProperties instead of just data
        // ReactMarkdown doesn't preserve node.data, but DOES preserve hProperties as props
        node.data.hProperties = {
          ...node.data.hProperties,
          selectionText: selectionText, // This becomes a prop on the React component
        };

        console.log('✅ [artifactPlugin] Added selectionText to hProperties (will become prop):', {
          selectionTextLength: selectionText.length,
          CRITICAL: 'SelectionComponent will receive this as props.selectionText',
        });

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
            console.log('childcode', codeChild);
            console.log(
              'Extracted code block for artifact update:',
              extractedAttributes.identifier,
            );
          }
        }
        if (codeBlock) {
          // CRITICAL: DO NOT save to cache here during plugin processing
          // The plugin runs on EVERY streaming chunk, causing duplicates
          // Instead, attach the code to node.data for the component to handle
          // The component will save to cache only when streaming completes (isSubmitting === false)
          if (!node.data) {
            node.data = {};
          }
          node.data.extractedCode = codeBlock;
          node.data.extractedAttributes = extractedAttributes;
        }
      }

      // Check if there are any other attribute sources
      if (node.label) {
        extractedAttributes.identifier = node.label;
      }

      console.log('Extracted attributes:', extractedAttributes);

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
  const _lastProcessedContentHash = useRef<string | null>(null); // Track processed content by hash
  const [_refreshTrigger, _setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);

  // Track streaming state to save cache only when complete
  const lastIsSubmittingRef = useRef<boolean>(false);
  const pendingCacheUpdates = useRef<
    Map<string, { content: string; metadata: any; conversationId?: string; messageId?: string }>
  >(new Map());

  useEffect(() => {
    const handleBeforeUnload = () => {
      console.log('⚠️ [Artifact] Page unloading, flushing pending database syncs...');
      // Use sendBeacon API for reliable data sending during page unload
      artifactCache.flushPendingSyncs();
    };

    // Add event listener for page unload
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Cleanup function called when component unmounts
    return () => {
      console.log('🧹 [Artifact] Component unmounting, flushing pending database syncs...');
      window.removeEventListener('beforeunload', handleBeforeUnload);
      artifactCache.flushPendingSyncs();
    };
  }, []);

  let displayArtifact;
  useEffect(() => {

    const wasStreaming = lastIsSubmittingRef.current;
    const isNowComplete = !artifactsContext.isSubmitting; // Changed from isStreaming to isSubmitting

    if (wasStreaming && isNowComplete) {
      console.log('✅✅✅ [Artifact] STREAMING COMPLETE (detected via context)', {
        hasPendingCacheUpdates: pendingCacheUpdates.current.size > 0,
        timestamp: new Date().toISOString(),
        CRITICAL: 'Now processing final merge and marking artifacts as complete',
      });

      // This allows the last streaming chunk to be processed before we merge
      setTimeout(() => {
        console.log('🔄 [Artifact] Post-streaming merge starting...', {
          timestamp: new Date().toISOString(),
        });

        // We detect new artifacts by checking if they were created within the last 5 seconds
        const recentThreshold = 5000; // 5 seconds

        setArtifacts((prevArtifacts) => {
          const updatedArtifacts = { ...prevArtifacts };
          const hasUpdates = false;

          // Find all update artifacts
          const updateArtifacts = Object.values(updatedArtifacts).filter((a) => a?.isUpdate);

          // Filter to only RECENT updates (created within last 5 seconds)
          const recentUpdates = updateArtifacts.filter((a) => {
            const age = a?.lastUpdateTime ? Date.now() - a.lastUpdateTime : Infinity;
            return age < recentThreshold;
          });

          console.log('📊 [Artifact] Analyzing artifacts for post-streaming merge:', {
            totalArtifacts: Object.keys(updatedArtifacts).length,
            totalUpdateArtifacts: updateArtifacts.length,
            recentUpdateArtifacts: recentUpdates.length,
            recentUpdateIds: recentUpdates.map((a) => a?.id),
            CRITICAL: 'Only merging RECENT updates (within 5 seconds), not re-processing old ones',
          });

          Object.keys(updatedArtifacts).forEach((artifactId) => {
            const artifact = updatedArtifacts[artifactId];

            // Skip if not an update artifact
            if (!artifact || !artifact.isUpdate) {
              return;
            }

            // CRITICAL FIX: Skip if this is an OLD update (already processed)
            // Only merge RECENT updates that just finished streaming
            const artifactAge = artifact.lastUpdateTime
              ? Date.now() - artifact.lastUpdateTime
              : Infinity;
            const isRecentUpdate = artifactAge < recentThreshold;

            if (!isRecentUpdate) {
              console.log('⏭️ [Artifact] Skipping OLD update artifact (already processed):', {
                artifactId,
                age: artifactAge,
                ageInSeconds: Math.floor(artifactAge / 1000),
                threshold: recentThreshold,
                REASON: 'This update was created in a previous streaming session',
              });
              return;
            }
            // Process this recent update artifact

            // Find the base artifact for this update
            const _baseArtifact = Object.values(updatedArtifacts).find(
              (a) => a && !a.isUpdate && a.identifier === artifact.identifier,
            );
          });

          if (hasUpdates) {
            console.log('🎯✅ [Artifact] Post-streaming merge COMPLETE - artifacts updated', {
              timestamp: new Date().toISOString(),
            });
          } else {
            console.log('⚠️ [Artifact] Post-streaming merge - no updates needed', {
              timestamp: new Date().toISOString(),
              possibleReasons: [
                'All artifacts already merged',
                'No update artifacts found',
                'Merge returned same content',
              ],
            });
          }

          return hasUpdates ? updatedArtifacts : prevArtifacts;
        });
      }, 100); // 100ms delay to ensure React finishes processing streaming chunks

      // CRITICAL: Save pending selections FIRST (before content updates)
      // Use async IIFE to handle await
      (async () => {
        console.log('🔍 [Artifact] Checking sessionStorage for pending selections...');
        const sessionKeys = Object.keys(sessionStorage);
        const pendingSelectionKeys = sessionKeys.filter((key) =>
          key.startsWith('selection_pending_'),
        );

        console.log('📋 [Artifact] Found pending selection keys:', {
          total: pendingSelectionKeys.length,
          keys: pendingSelectionKeys,
        });

        // Process each pending selection
        for (const pendingSelectionKey of pendingSelectionKeys) {
          const pendingSelectionData = sessionStorage.getItem(pendingSelectionKey);
          if (!pendingSelectionData) continue;

          try {
            const pendingSelection = JSON.parse(pendingSelectionData);
            const messageId = pendingSelectionKey.replace('selection_pending_', '');

            console.log('📍 [Artifact] Processing pending selection:', {
              messageId,
              selectionContext: pendingSelection,
              SOURCE: 'sessionStorage (from :::selection::: directive)',
            });

            // Find the corresponding update artifact for this messageId
            const matchingArtifacts = _artifacts
              ? Object.values(_artifacts).filter(
                  (a: any) => a?.messageId === messageId && a?.isUpdate === true,
                )
              : [];

            if (matchingArtifacts.length > 0) {
              const latestUpdate = matchingArtifacts[matchingArtifacts.length - 1] as any;
              const artifactId = latestUpdate.id;

              console.log('✅ [Artifact] Found matching update artifact for selection:', {
                artifactId,
                messageId,
                CRITICAL: 'Saving selection to database NOW (streaming complete)',
              });

              // CRITICAL: Get conversationId - it MUST be available now
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

              // CRITICAL: Sync to database IMMEDIATELY (await for confirmation)
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
                console.log(
                  '🧹 [Artifact] Cleared selection from sessionStorage:',
                  pendingSelectionKey,
                );
              } catch (error) {
                console.error('❌❌❌ [Artifact] Selection database save FAILED:', {
                  error,
                  artifactId: primaryKey,
                  conversationId,
                  messageId,
                  WILL_RETRY: 'Selection remains in sessionStorage for retry',
                });
              }
            } else {
              console.warn('⚠️ [Artifact] No matching update artifact found for selection:', {
                messageId,
                willRetryLater: 'Selection remains in sessionStorage',
              });
            }
          } catch (error) {
            console.error('❌ [Artifact] Failed to parse pending selection:', error);
          }
        }

        // NOW process content updates AFTER selections are saved
      if (pendingCacheUpdates.current.size > 0) {
          const artifactsToUpdate: Record<string, any> = {};

      pendingCacheUpdates.current.forEach((update, artifactId) => {
            console.log('💾 [Artifact] Saving pending content update to cache:', artifactId, {
              conversationId: update.conversationId,
              messageId: update.messageId,
              hasConversationId: !!update.conversationId,
            contentLength: update.content?.length || 0,
            contentPreview: update.content?.substring(0, 200) || 'NO CONTENT',
            isFullDocument:
              update.content?.includes('<!DOCTYPE') || update.content?.includes('<html>'),
            metadata: update.metadata,
              CRITICAL: 'Using conversationId captured when update was queued',
          });

          // CRITICAL: Pass conversationId in metadata for database sync
          artifactCache.setContent(artifactId, update.content, {
            ...update.metadata,
              conversationId: update.conversationId, // Override after spread
              messageId: update.messageId, // Override after spread
          });

            //console.log('✅ [Artifact] Content cache save completed for:', artifactId);

            // CRITICAL FIX: Also prepare to update the artifact in Recoil state
            // This ensures the state has the FULL merged content, not just the snippet
            artifactsToUpdate[artifactId] = {
              content: update.content,
              isMerged: true,
            };
      });

      // Clear the pending updates
      pendingCacheUpdates.current.clear();
          console.log('🧹 [Artifact] Cleared pending cache updates');

          // CRITICAL FIX: Update all artifacts in Recoil state with full merged content
          // This happens AFTER streaming completes, replacing snippets with full content
          if (Object.keys(artifactsToUpdate).length > 0) {
            setArtifacts((prevArtifacts) => {
              const updatedArtifacts = { ...prevArtifacts };

              Object.keys(artifactsToUpdate).forEach((artifactId) => {
                const existingArtifact = updatedArtifacts[artifactId];
                if (existingArtifact) {
                  updatedArtifacts[artifactId] = {
                    ...existingArtifact,
                    content: artifactsToUpdate[artifactId].content, // Full merged content
                    isMerged: artifactsToUpdate[artifactId].isMerged,
                    lastUpdateTime: Date.now(),
                  };

                  console.log('✅ [Artifact] Updated state with FULL merged content:', artifactId, {
                    previousContentLength: existingArtifact.content?.length || 0,
                    newContentLength: artifactsToUpdate[artifactId].content?.length || 0,
                    CRITICAL: 'Replaced snippet with full merged content in state',
                  });
                }
              });

              return updatedArtifacts;
            });

            //console.log('✅✅✅ [Artifact] ALL artifacts updated in state with full content');
          }
        }

        // CRITICAL: Flush any pending database syncs immediately after streaming completes
        // This ensures all debounced writes happen now instead of waiting for the timer
        console.log('🌊 [Artifact] Flushing pending database syncs...');
        await artifactCache.flushPendingSyncs();
        console.log('✅✅✅ [Artifact] All database syncs completed (selections + content)');
      })();
    }

    // Track previous streaming state
    lastIsSubmittingRef.current = artifactsContext.isSubmitting; // Changed from isStreaming
  }, [artifactsContext.isSubmitting, conversationId, setArtifacts, _artifacts]); // Changed dependency from isStreaming to isSubmitting

  const updateArtifact = useCallback(() => {
    let content = '';

    // Strategy 1: Check if plugin extracted code for us
    if ((node as any)?.data?.extractedCode) {
      const rawContent = (node as any).data.extractedCode;
      const hasStandaloneCSSProperty = /^[a-z-]+:\s*$/m.test(rawContent);
      const hasPartialText = /^[a-z]{1,3}\s+[a-z]+/m.test(rawContent);

      if (hasStandaloneCSSProperty || hasPartialText) {
        console.error('🚨 CORRUPTED CONTENT DETECTED - Extracted code contains garbage!', {
          hasStandaloneCSSProperty,
          hasPartialText,
          contentPreview: rawContent.substring(0, 300),
          REFUSING_TO_USE: true,
        });

        // Fall back to extracting from code block instead
        console.warn('⚠️ Falling back to code block extraction...');
        content = ''; // Clear content to trigger fallback
    } else {
        content = rawContent;
      }
    }

        // Last resort fallback
        content = extractContent(props.children);
        console.warn(
          '⚠️ No code block found, using extractContent (may cause duplication):',
          content.length,
          'chars',
        );

    // Skip if still no content
    if (!content || content.trim() === '') {
      console.log('⏭️ No content extracted, skipping artifact update');
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

    console.log('🔍 [shouldUpdate Check]:', {
      identifier,
      isArtifactUpdateNode,
      shouldUpdate,
      identifierIsDefault: identifier === defaultIdentifier,
      defaultIdentifier,
      REASON: isArtifactUpdateNode
        ? identifier === defaultIdentifier
          ? 'artifactupdate tag BUT identifier is default - WILL NOT UPDATE'
          : 'Explicit <artifactupdate> tag with valid identifier'
        : 'Regular <artifact> tag - will REPLACE content, not merge',
    });

    let finalContent = content;

    if (shouldUpdate) {
      // Find the existing original artifact with matching identifier
      const existingArtifact = Object.values(_artifacts || {}).find(
        (a) =>
          a &&
          typeof a.identifier === 'string' &&
          (a.identifier === identifier || a.identifier.startsWith(identifier)),
      );

      console.log('🔍 Search result for existing artifact:', existingArtifact);

      if (existingArtifact) {
        const matchingArtifacts = Object.values(_artifacts || {}).filter(
          (a) =>
            a &&
            typeof a.identifier === 'string' &&
            (a.identifier === identifier || a.identifier.startsWith(identifier)),
        );

        // Sort by lastUpdateTime to find the most recent
        matchingArtifacts.sort((a, b) => (b?.lastUpdateTime || 0) - (a?.lastUpdateTime || 0));

        const mostRecentArtifact = matchingArtifacts[0] || existingArtifact;
        const baseArtifact = matchingArtifacts.find((a) => a && !a.isUpdate) || existingArtifact;

        // CRITICAL FIX: Use CACHED merged content from previous update if available
        // This ensures we're building on the FULL artifact, not just the update snippet
        let baseContent = '';

        if (mostRecentArtifact?.isUpdate) {
          // Try to get the cached merged content from the previous update
          const cachedPreviousUpdate = artifactCache.getContent(mostRecentArtifact.id);

          if (cachedPreviousUpdate?.content && cachedPreviousUpdate.content.trim() !== '') {
            baseContent = cachedPreviousUpdate.content;

            // CRITICAL: Detect and fix content duplication in cached content (works for ANY file type)
            // Strategy: Look for repeated patterns in the first 500 chars
            const sampleSize = Math.min(500, Math.floor(baseContent.length / 3));
            const firstChunk = baseContent.substring(0, sampleSize);
            const isDuplicated = baseContent.indexOf(firstChunk, sampleSize) !== -1;

            if (isDuplicated) {
              // Find where the duplication starts
              const duplicateStartIndex = baseContent.indexOf(firstChunk, sampleSize);

              console.error('🚨🚨🚨 [DUPLICATION DETECTED] Cached content has duplicated sections!', {
                  previousUpdateId: mostRecentArtifact.id,
                  contentLength: baseContent.length,
                  duplicateStartsAt: duplicateStartIndex,
                  sampleSize,
                  contentPreview: baseContent.substring(0, 300),
                  FIXING: 'Extracting first occurrence only (before duplication)',
                },
              );
              // Extract only the first occurrence (before the duplicate starts)
              baseContent = baseContent.substring(0, duplicateStartIndex);

              // console.log('✅ Fixed duplication - using first section only:', {
              //   newLength: baseContent.length,
              //   newPreview: baseContent.substring(0, 150),
              //   removedBytes: cachedPreviousUpdate.content.length - baseContent.length,
              // });
            }

            // console.log('✅ [CHAIN UPDATES] Using CACHED merged content from previous update:', {
            //   previousUpdateId: mostRecentArtifact.id,
            //   cachedContentLength: baseContent.length,
            //   cachedContentPreview: baseContent.substring(0, 150),
            //   isDuplicated,
            //   SOURCE: 'ArtifactCache - full merged result from previous update',
            //   CRITICAL: 'Building on complete artifact, not snippet',
            // });
          } else {
            // Fallback: use raw content from previous update (might be snippet only)
            baseContent = mostRecentArtifact.content || baseArtifact?.content || '';
            console.warn(
              '⚠️ [CHAIN UPDATES] No cached content - using raw previous update content:',
              {
                previousUpdateId: mostRecentArtifact.id,
                rawContentLength: baseContent.length,
                WARNING: 'May be snippet only, not full artifact',
              },
            );
          }
        } else {
          // Base artifact - use its content directly
          baseContent = mostRecentArtifact?.content || existingArtifact.content || '';
          // console.log('ℹ️ [CHAIN UPDATES] Using base artifact content:', {
          //   baseArtifactId: mostRecentArtifact?.id,
          //   contentLength: baseContent.length,
          // });
        }

        // console.log('🎯 [CHAIN UPDATES] Selected base content for new update:', {
        //   mostRecentArtifactId: mostRecentArtifact?.id,
        //   mostRecentIsUpdate: mostRecentArtifact?.isUpdate,
        //   baseArtifactId: baseArtifact?.id,
        //   baseContentLength: baseContent.length,
        //   baseContentPreview: baseContent.substring(0, 150),
        //   usingContent: mostRecentArtifact?.isUpdate
        //     ? 'Cached merged result from previous update'
        //     : 'Original base artifact',
        //   CRITICAL: "Each update builds on the previous update's FULL merged content",
        // });

        // CRITICAL: Calculate the correct index for this update BEFORE creating the key
        // Count all existing update artifacts with the same identifier
        const existingUpdates = _artifacts
          ? Object.values(_artifacts).filter(
              (a) => a && a.isUpdate && a.identifier === existingArtifact.identifier,
            )
          : [];
        const existingUpdateForThisMessage = _artifacts
          ? Object.values(_artifacts).find(
              (a) =>
                a &&
                a.isUpdate &&
                a.identifier === existingArtifact.identifier &&
                a.messageId === messageId,
            )
          : null;

        // CRITICAL FIX: Ensure updateIndex is ALWAYS a valid number (0, 1, 2, ...)
        // If existingUpdateForThisMessage.index is undefined, fallback to existingUpdates.length
        let updateIndex: number;
        if (
          existingUpdateForThisMessage &&
          typeof existingUpdateForThisMessage.index === 'number'
        ) {
          updateIndex = existingUpdateForThisMessage.index; // Reuse existing index
        } else {
          updateIndex = existingUpdates.length; // New update - use next available index
        }

        const updateArtifactKey =
          `${existingArtifact.identifier}_update${updateIndex}_${type}_${title}`
            .replace(/\s+/g, '_')
            .toLowerCase();

        console.log('🔑 [Artifact Update] Generated artifact key:', {
          updateArtifactKey,
          hasUpdateIndex: updateArtifactKey.includes(`_update${updateIndex}_`),
          expectedPattern: `identifier_update${updateIndex}_type_title`,
          CRITICAL: 'Key does NOT include messageId or timestamp - must match ArtifactCodeEditor',
        });

        const _isStreaming = artifactsContext?.isSubmitting; // Changed from isStreaming to isSubmitting
        let noMergeHappened = false;
        const wasTruncated =
          content.length > 0 && finalContent.length < baseContent.length + content.length;

        if (_isStreaming || wasTruncated) {
          // STREAMING: Just store the incoming snippet as-is, don't merge yet
          console.log('🌊 [Artifact Update] STREAMING - storing snippet without merge:', {
            incomingContentLength: content.length,
            incomingContentPreview: content.substring(0, 150),
            updateArtifactKey,
            CRITICAL: 'Merge will happen when streaming completes',
          });

          // Store the snippet directly - no merge during streaming
          finalContent = content;
          noMergeHappened = true; // Flag that we haven't merged yet
        } else {
          // NOT STREAMING: Perform the merge now
        //   console.log('🔬 [DEBUG] BEFORE applyPartialUpdate (streaming complete):', {
        //   baseContentLength: baseContent.length,
        //     baseContentPreview: baseContent.substring(0, 150),
        //     baseContentLines: baseContent.split('\n').length,
        //     incomingContentLength: content.length,
        //     incomingContentPreview: content,
        //     updateArtifactKey,
        //     mostRecentArtifactId: mostRecentArtifact?.id,
        //     mostRecentIsUpdate: mostRecentArtifact?.isUpdate,
        //     CRITICAL: 'Streaming complete - performing ONE-TIME merge into MOST RECENT content',
        // });
        
        finalContent = applyPartialUpdate(
            baseContent, // Content from mostRecentArtifact (could be base or previous update)
            content, // NEW snippet from LLM (COMPLETE)
            updateArtifactKey, // Use UPDATE artifact key for selection lookup
            Object.keys(_artifacts || {}).length,
          _artifacts || undefined,
        );
      }
        
        // console.log('✅ [Artifact Update] Processing result:', {
        //   finalContentLength: finalContent?.length || 0,
        //   finalContentPreview: finalContent?.substring(0, 300) || 'EMPTY',
        //   finalContentLines: finalContent?.split('\n').length || 0,
        //   isStreaming: _isStreaming,
        //   wasContentTruncated:
        //     content.length > 0 && finalContent.length < baseContent.length + content.length,
        //   isUnchangedBase: finalContent === baseContent,
        //   baseContentLength: baseContent.length,
        //   snippetLength: content.length,
        //   noMergeHappened,
        // });

        if (!_isStreaming) {
          noMergeHappened = finalContent === baseContent;
        }

        if (noMergeHappened) {
          console.warn('⚠️ [Artifact Update] No merge happened - selection context missing!', {
            baseContentLength: baseContent.length,
            snippetLength: content.length,
            DECISION: 'Will display SNIPPET in update artifact, keep base unchanged',
          });

          // Use the snippet as the display content for this update artifact
          // The base artifact remains unchanged
          finalContent = content; // Show the snippet
        }

        // CRITICAL: If merge failed, fallback to original content to prevent data loss
        if (!finalContent || finalContent.trim() === '') {
          console.error(
            '⚠️ applyPartialUpdate returned empty content! Using baseContent as fallback',
          );
          finalContent = baseContent || content;
        }

        // Update the lastContent ref to track this merged result
        lastContent.current = finalContent;

        const updateArtifact: Artifact = {
          id: updateArtifactKey,
          identifier: existingArtifact.identifier,
          title: existingArtifact.title,
          type: existingArtifact.type,
          content: finalContent,
          messageId,
          index: updateIndex,
          lastUpdateTime: Date.now(),
          isUpdate: true, // Mark as an update artifact
        };

        // console.log('🔍 Update artifact created:', {
        //   id: updateArtifact.id,
        //   identifier: updateArtifact.identifier,
        //   isUpdate: updateArtifact.isUpdate,
        //   contentLength: updateArtifact.content?.length || 0,
        //   contentPreview: updateArtifact.content?.substring(0, 100) || '',
        //   CRITICAL_ID_CHECK: {
        //     updateArtifactKey,
        //     updateArtifact_id: updateArtifact.id,
        //     areEqual: updateArtifactKey === updateArtifact.id,
        //     hasUpdate: updateArtifact.id.includes('_update'),
        //   },
        // });

        // CRITICAL: Check for pending selection from :::selection::: directive FIRST
        // This selection was parsed and saved by the Selection component BEFORE artifactupdate
        const pendingSelectionKey = `selection_pending_${messageId}`;
        const pendingSelectionData = sessionStorage.getItem(pendingSelectionKey);
        let pendingSelection: any = null;

        // console.log('🔍 [Artifact] Checking for pending selection...', {
        //   messageId,
        //   storageKey: pendingSelectionKey,
        //   hasPendingData: !!pendingSelectionData,
        //   allSessionStorageKeys: Object.keys(sessionStorage),
        // });

        if (pendingSelectionData) {
          try {
            pendingSelection = JSON.parse(pendingSelectionData);
            console.log('📍✅ [Artifact] Found pending selection from :::selection::: directive:', {
              messageId,
              pendingSelection,
              SOURCE: 'Selection component via sessionStorage',
            });

            // Clear it from sessionStorage now that we've retrieved it
            sessionStorage.removeItem(pendingSelectionKey);

            // CRITICAL FIX: Save selection to MULTIPLE cache keys to ensure applyPartialUpdate can find it
            // The merge function searches for selections using different strategies and keys
            const selectionSaveKeys: string[] = [
              updateArtifact.id, // Strategy 1: Exact artifact ID (e.g., "tiny-html_update0_1234567890")
            ];

            // Add base identifier if available
            if (existingArtifact.identifier) {
              selectionSaveKeys.push(existingArtifact.identifier); // Strategy 1.5: Base identifier (e.g., "tiny-html")
            }

            // If there's a base artifact, also save with its ID
            if (baseArtifact?.id) {
              selectionSaveKeys.push(baseArtifact.id);
            }

            console.log('💾 [Artifact] Saving selection to multiple cache keys for findability:', {
              keys: selectionSaveKeys,
              reason: 'Ensures applyPartialUpdate can find selection via any search strategy',
            });

            // CRITICAL: Batch the selection saves to prevent quota exceeded
            // Add all entries to cache first WITHOUT triggering storage saves
            selectionSaveKeys.forEach((key, index) => {
              const selectionData = {
                ...pendingSelection,
                conversationId: conversationId || undefined,
                timestamp: Date.now(),
              };

              // Add to cache directly (bypass setSelection to avoid multiple storage saves)
              artifactCache._selectionCache.set(key, selectionData);
              console.log(
                `  ✅ Added selection to cache key ${index + 1}/${selectionSaveKeys.length}: ${key}`,
              );
            });

            // CRITICAL: Save to storage ONCE after all entries are added
            artifactCache._saveToStorage();
            console.log('💾 [Artifact] Saved all selections to localStorage in ONE operation');

            // CRITICAL: Sync to database ONCE using the first (primary) key
            // Database will handle finding the selection via any key
            // BUT ONLY IF WE HAVE A CONVERSATIONID - otherwise entries won't be retrievable!
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

            console.log(
              '💾 [Artifact] Successfully saved pending selection to all cache keys. Total keys:',
              selectionSaveKeys.length,
            );
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
        console.log('📋 [Artifact] All cached selections:', {
          totalEntries: allSelectionEntries.length,
          entries: allSelectionEntries.map(([key, val]) => ({
            key,
            artifactId: val.artifactId,
            messageId: val.artifactMessageId,
            timestamp: val.timestamp,
            startLine: val.startLine,
            endLine: val.endLine,
          })),
        });

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

        // console.log('🔍 [Artifact] Selection search results:', {
        //   strategyMessageId: {
        //     count: matchingByMessageId.length,
        //     selections: matchingByMessageId.map(([k, v]) => ({
        //       key: k,
        //       messageId: v.artifactMessageId,
        //       timestamp: v.timestamp,
        //     })),
        //   },
        //   strategyIdentifier: {
        //     count: matchingByIdentifier.length,
        //     selections: matchingByIdentifier.map(([k, v]) => ({
        //       key: k,
        //       messageId: v.artifactMessageId,
        //       timestamp: v.timestamp,
        //     })),
        //   },
        // });

        // Use messageId match if found, otherwise fall back to most recent by identifier
        const matchingSelections =
          matchingByMessageId.length > 0 ? matchingByMessageId : matchingByIdentifier;

        // CRITICAL: Prioritize pending selection from :::selection::: directive over cache
        // This ensures the LLM's explicit location information is used first
        let sourceSelectionContext: any = null;
        if (pendingSelection) {
          sourceSelectionContext = pendingSelection;
          console.log(
            '📍✅ [Artifact] Using pending selection from :::selection::: directive (highest priority)',
          );
        } else if (matchingSelections.length > 0) {
          sourceSelectionContext = matchingSelections[0][1];
          console.log('📍 [Artifact] Using cached selection context (fallback)');
        }

        if (sourceSelectionContext) {
          // console.log('✅ [Artifact] Found selection context for this update:', {
          //   sourceKey: matchingSelections[0][0],
          //   strategy: matchingByMessageId.length > 0 ? 'messageId' : 'identifier+timestamp',
          //   startLine: sourceSelectionContext.startLine,
          //   endLine: sourceSelectionContext.endLine,
          //   startColumn: sourceSelectionContext.startColumn,
          //   endColumn: sourceSelectionContext.endColumn,
          //   originalText: sourceSelectionContext.originalText?.substring(0, 100),
          //   CURRENT_CONTENT: content.substring(0, 100),
          // });

          const selectionWithCurrentContent = {
              ...sourceSelectionContext,
            updatedText: content, // The CURRENT snippet from LLM
            artifactId: updateArtifact.id,
          };

          artifactCache.setSelection(updateArtifact.id, selectionWithCurrentContent, {
            conversationId: conversationId || undefined,
            messageId: messageId || undefined,
          });
        } else {
          console.error(
            '❌❌❌ [Artifact] NO SELECTION CONTEXT FOUND - This will cause merge to fail!',
            {
              messageId,
              artifactId: updateArtifact.id,
              identifier: existingArtifact.identifier,
              cacheSize: allSelectionEntries.length,
              availableMessageIds: allSelectionEntries.map(([_k, v]) => v.artifactMessageId),
              CRITICAL: 'Update will display snippet-only without proper merge',
            },
          );

          console.warn(
            '⚠️ [Artifact] Saving update without selection context - will need manual merge later',
          );
        }
        if (!noMergeHappened) {
          // CRITICAL: Warn if conversationId is missing
          if (!conversationId) {
            console.error('❌❌❌ [Artifact] Queuing update WITHOUT conversationId!', {
              artifactId: updateArtifact.id,
              conversationIdFromContext: artifactsContext.conversationId,
              conversationIdFromURL: location.pathname.match(/\/c\/([^/]+)/)?.[1],
              pathname: location.pathname,
              BLOCKER: 'This will fail to save to database!',
            });
          }

          // CRITICAL: Detect and prevent saving duplicated content to cache (works for ANY file type)
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

            console.log('✅ Fixed duplication before saving to cache:', {
              newLength: contentToSave.length,
              removedBytes: finalContent.length - contentToSave.length,
            });
          }

          pendingCacheUpdates.current.set(updateArtifact.id, {
            content: contentToSave, // Save de-duplicated content
            conversationId: conversationId ?? undefined, // CRITICAL: Capture conversationId NOW (convert null to undefined)
            messageId: messageId,
            metadata: {
              title: updateArtifact.title,
              type: updateArtifact.type,
              identifier: updateArtifact.identifier,
              source: 'directive',
            },
          });

          console.log('📝 [Artifact] Queued cache save for UPDATE artifact:', {
            artifactId: updateArtifact.id,
            contentLength: finalContent.length,
            contentPreview: finalContent.substring(0, 200),
            pendingCount: pendingCacheUpdates.current.size,
            isFullDoc: finalContent.includes('<!DOCTYPE') || finalContent.includes('<html>'),
          });
        } else {
          console.warn('⚠️ [Artifact] NOT queuing cache save for UPDATE - no merge happened!', {
            updateArtifactId: updateArtifact.id,
            snippetLength: content.length,
            REASON: 'Would save snippet instead of full document - cache must have full content',
          });
        }

        if (existingArtifact && existingArtifact.id && !noMergeHappened) {
          // CRITICAL: Detect and prevent saving duplicated content to cache (works for ANY file type)
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

            console.log('✅ Fixed duplication before saving to BASE cache:', {
              newLength: baseContentToSave.length,
              removedBytes: finalContent.length - baseContentToSave.length,
            });
          }

          pendingCacheUpdates.current.set(existingArtifact.id, {
            content: baseContentToSave, // Save de-duplicated content
            conversationId: conversationId ?? undefined, // CRITICAL: Capture conversationId NOW (convert null to undefined)
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

        // console.log('🔍 Streaming state check:', {
        //   isStreaming: artifactsContext.isSubmitting,
        //   updateArtifactKey,
        //   snippetLength: updateArtifact.content?.length || 0,
        //   mergedLength: finalContent.length,
        //   noMergeHappened,
        //   WILL_SAVE: 'MERGED CONTENT (always)',
        // });

        const displayArtifact = {
          ...updateArtifact,
          content: finalContent, // ALWAYS use merged content for display
          isMerged: !artifactsContext.isSubmitting && !noMergeHappened, // Only mark as merged if merge succeeded (using isSubmitting)
        };

        setArtifacts((prevArtifacts) => {
          console.log('💾 [Artifact] Storing artifact with MERGED CONTENT:', updateArtifactKey, {
            snippetLength: updateArtifact.content?.length || 0,
            mergedLength: finalContent.length,
            isStreaming: artifactsContext.isSubmitting, // Changed to isSubmitting
            CRITICAL: 'This should trigger UI refresh immediately',
          });
          return {
            ...prevArtifacts,
            [updateArtifactKey]: displayArtifact, // ALWAYS store merged content
          };
        });

        setArtifact(displayArtifact); // Set local state with merged content
        setCurrentArtifactId(updateArtifact.id);

        console.log('🔄 [Artifact] Forcing refresh trigger for UI update');
        _setRefreshTrigger((prev) => prev + 1);

            setArtifactsVisible(true);

        console.log('✅ [Artifact] Set artifact with MERGED CONTENT for display:', {
          artifactId: updateArtifact.id,
          identifier: updateArtifact.identifier,
          isUpdate: updateArtifact.isUpdate,
          snippetLength: updateArtifact.content?.length || 0,
          displayLength: finalContent.length,
          CRITICAL: 'Using finalContent for display, not snippet',
        });

        lastContent.current = content; // Track incoming snippet for deduplication

        return;
      } else {
        // CRITICAL: If this is an update node but no base artifact found yet,
        // create a minimal update artifact anyway - the base will come later
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

          console.log('📊 Update index calculation (no base) - USING LATEST STATE:', {
            identifier,
            existingUpdatesCount: existingUpdatesWithoutBase.length,
            calculatedIndex: updateIndexWithoutBase,
            existingIds: existingUpdatesWithoutBase.map((a) => a?.id),
            CRITICAL: 'Using prevArtifacts callback to avoid race conditions',
          });
          // console.log('index 1.3', updateIndexWithoutBase);

          // CRITICAL: DO NOT include messageId in the key! Must match ArtifactCodeEditor format
          // Format: identifier_updateN_type_title (same as line ~641)
          updateArtifactKey = `${identifier}_update${updateIndexWithoutBase}_${type}_${title}`
            .replace(/\s+/g, '_')
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
          conversationId: conversationId ?? undefined, // CRITICAL: Convert null to undefined for type safety
          index: updateIndexWithoutBase,
          lastUpdateTime: Date.now(),
          isUpdate: true, // Mark as update even without base
        };

        console.log('🔍 Created update artifact without base:', {
          id: updateArtifact.id,
          identifier: updateArtifact.identifier,
          isUpdate: updateArtifact.isUpdate,
          contentLength: updateArtifact.content?.length || 0,
        });

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
    console.log('🔍 Proceeding with regular artifact creation for identifier:', identifier);

    // CRITICAL: Double-check that this is NOT an update node
    // If it is, there's a bug in the shouldUpdate logic and we must not proceed
    if (isArtifactUpdateNode) {
      console.error('🚨🚨🚨 [CRITICAL BUG] artifactupdate node reached regular artifact path!', {
        isArtifactUpdateNode,
        identifier,
        shouldUpdateWas: shouldUpdate,
        REFUSING_TO_CREATE_WITH_MESSAGEID: true,
      });
      return; // Abort - this should never happen
    }

    // Generate the artifact key
    const artifactKey = `${identifier}_${type}_${title}_${messageId}`
      .replace(/\s+/g, '_')
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
      index: newIndex,
      lastUpdateTime: now,
      isUpdate: false,
    };
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
        });
      }

      // Always update - newer content replaces older during streaming
      return {
        ...prevArtifacts,
        [artifactKey]: currentArtifact,
      };
    });

    setArtifact(currentArtifact);
    setCurrentArtifactId(currentArtifact.id);
    setArtifactsVisible(true);

    // Queue cache update - will be saved when streaming completes
    console.log('⏸️ [Artifact] Queueing cache update for base artifact:', currentArtifact.id);

    pendingCacheUpdates.current.set(currentArtifact.id, {
      content: currentArtifact.content || '',
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
    if (_currentArtifactId && _artifacts && _artifacts[_currentArtifactId]) {
      const loadedArtifact = _artifacts[_currentArtifactId];
      const isPageRefresh =
        loadedArtifact.lastUpdateTime && Date.now() - loadedArtifact.lastUpdateTime > 2000;

      if (isPageRefresh && conversationId) {
        // Check if cache has been loaded by seeing if it has any entries
        const cacheSize = artifactCache._selectionCache.size;
        console.log('🔍 [Cache Reconstruction] Checking if cache is loaded:', {
          artifactId: loadedArtifact.id,
          cacheSize,
          conversationId,
          isPageRefresh,
        });

        // If cache is empty but we're on page refresh, WAIT for cache to load
        if (cacheSize === 0) {
          console.log('⏳ [Cache Reconstruction] Cache empty - loading from database...');

          // Load cache from database before proceeding with reconstruction
          artifactCache.loadConversationCache(conversationId).then(() => {
            const newCacheSize = artifactCache._selectionCache.size;
            console.log(
              '✅ [Cache Reconstruction] Cache loaded! Selection cache size:',
              newCacheSize,
            );

            // Force a re-render to trigger reconstruction with loaded cache
            // We can do this by updating a state variable or using forceUpdate
            // For now, we'll just let the useEffect run again naturally
          });

          // Exit early - let the useEffect run again after cache loads
      return;
    }
      }

      // Detect corruption patterns (truncated tags, partial fragments)
      const isCorrupted =
        loadedArtifact.content &&
        (loadedArtifact.content.startsWith('iv style') || // Truncated HTML
          !!loadedArtifact.content.match(/^[a-z]{1,3}\s+style/)); // Partial tag fragments

      // Check if this artifact was recently created (within last 2 seconds)
      // This indicates it's a NEW update from updateArtifact(), not a page refresh
      const isRecentlyCreated =
        loadedArtifact.lastUpdateTime && Date.now() - loadedArtifact.lastUpdateTime < 2000;

      // Content is "substantial" if it's longer than 50 chars and not corrupted
      // This works for ANY artifact format (HTML, React, Python, SVG, etc.)
      const hasSubstantialContent =
        loadedArtifact.content && loadedArtifact.content.trim().length > 50 && !isCorrupted;

      const cachedContent = artifactCache.getContent(loadedArtifact.id);
      // console.log('🔍 [Cache Reconstruction] ========== CACHE CHECK (STEP 1) ==========', {
      //   artifactId: loadedArtifact.id,
      //   hasCachedContent: !!cachedContent,
      //   cachedContentLength: cachedContent?.content?.length || 0,
      //   cachedContentPreview: cachedContent?.content || 'NO CACHED CONTENT',
      //   cacheTimestamp: cachedContent?.timestamp,
      //   cacheSource: cachedContent?.source,
      //   loadedHasContent: !!loadedArtifact.content,
      //   loadedContentLength: loadedArtifact.content?.length || 0,
      //   WILL_USE_CACHE: !!(
      //     cachedContent &&
      //     cachedContent.content &&
      //     cachedContent.content.trim() !== ''
      //   ),
      // });

      // CRITICAL: If we have cached merged content, use it directly (skip reconstruction)
      if (cachedContent && cachedContent.content && cachedContent.content.trim() !== '') {
        // console.log(
        //   '🎯✅✅✅ [Cache Reconstruction] CACHE HIT! Using cached content directly - NO MERGE NEEDED!',
        //   {
        //     artifactId: loadedArtifact.id,
        //     cachedContentLength: cachedContent.content.length,
        //     cacheAge: Date.now() - (cachedContent.timestamp || 0),
        //     PERFORMANCE: '⚡ FASTEST PATH - Direct cache use',
        //   },
        // );
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
      } else {
        console.log(
          '⚠️ [Cache Reconstruction] CACHE MISS - No cached content, will need reconstruction',
          {
            artifactId: loadedArtifact.id,
            isUpdate: loadedArtifact.isUpdate,
            PERFORMANCE: '🐢 SLOW PATH - Must merge from base',
          },
        );
      }

      // If this is an update artifact, check CACHE FIRST before merging
      if (loadedArtifact.isUpdate) {
        console.log('🔄 [Cache Reconstruction] Update artifact detected - checking cache FIRST');
        
        // STEP 1: Check if we have cached merged content (this is the FASTEST path)
        const cachedMergedContent = artifactCache.getContent(loadedArtifact.id);
        if (
          cachedMergedContent &&
          cachedMergedContent.content &&
          cachedMergedContent.content.trim() !== ''
        ) {
          console.log(
            '🎯✅ [Cache Reconstruction] FOUND CACHED MERGED CONTENT - Using directly without merge!',
            {
              artifactId: loadedArtifact.id,
              cachedContentLength: cachedMergedContent.content.length,
              cachedContentPreview: cachedMergedContent.content.substring(0, 200),
              timestamp: cachedMergedContent.timestamp,
              source: cachedMergedContent.source,
              PERFORMANCE: 'FAST PATH - No merge needed!',
            },
          );

          const cachedArtifact = {
            ...loadedArtifact,
            content: cachedMergedContent.content,
            isMerged: true,
          };

          // CRITICAL: Only update LOCAL state to avoid infinite loop
          setArtifact(cachedArtifact);
          // CRITICAL: Set this as the current artifact so it's displayed
          setCurrentArtifactId(cachedArtifact.id);
          // DO NOT call setArtifacts - causes infinite loop!
          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        } else {
          console.log(
            '⚠️ [Cache Reconstruction] No cached merged content found, will need to merge',
            {
              artifactId: loadedArtifact.id,
              hasCachedContent: !!cachedMergedContent,
              cachedContentEmpty: cachedMergedContent?.content?.trim() === '',
            },
          );
        }

        const isCorrupted =
          loadedArtifact.content &&
          (loadedArtifact.content.startsWith('iv style') || // Detect corrupted/truncated content
            !!loadedArtifact.content.match(/^[a-z]{1,3}\s+style/)); // Detect partial tag fragments

        // Content is "complete" if it's longer than 50 chars and not corrupted
        // This works for ANY artifact format (HTML, React, Python, SVG, etc.)
        const hasCompleteContent =
          loadedArtifact.content && loadedArtifact.content.trim().length > 50 && !isCorrupted;

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
            console.log('🔄 [Cache Reconstruction] Found base artifact, will reconstruct:', {
              baseId: baseArtifact.id,
              baseContentLength: baseArtifact.content.length,
              willMergeUpdates: true,
            });

            // STEP 2: Try to get selection context to apply precise update
            const selectionContext = artifactCache.getSelection(loadedArtifact.id);

            // console.log('🔍🔍🔍 [Cache Reconstruction] Looking for selection context:', {
            //   lookingForArtifactId: loadedArtifact.id,
            //   selectionFound: !!selectionContext,
            //   selectionCacheSize: artifactCache._selectionCache.size,
            //   allSelectionKeys: Array.from(artifactCache._selectionCache.keys()),
            //   CRITICAL: 'If selection not found, updates will all go to same location',
            // });

            if (
              selectionContext &&
              typeof selectionContext.startLine === 'number' &&
              typeof selectionContext.endLine === 'number' &&
              selectionContext.originalText
            ) {
              console.log('✅ [Cache Reconstruction] Found selection context, applying update:', {
                selectionContext,
              });

              // Apply the update with selection context
              const mergedContent = applyAllPartialUpdates(
                baseArtifact.content,
                _artifacts,
                loadedArtifact.id,
                false, // Not streaming
                conversationId,
              );

              if (mergedContent && mergedContent.trim() !== '') {
                console.log('✅ [Cache Reconstruction] Successfully merged update with base:', {
                  mergedLength: mergedContent.length,
                });

                // CRITICAL: Display BASE artifact with merged content, not update artifact
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

                console.log(
                  '✅ [Cache Reconstruction] Set BASE artifact as current (with selection context):',
                  {
                    baseArtifactId: baseArtifact.id,
                    updateArtifactId: loadedArtifact.id,
                    DISPLAY: 'Base WITH all updates',
                  },
                );

                lastReconstructedArtifactId.current = _currentArtifactId;
                return;
              }
            }

            // STEP 3: Fallback to base content if merge failed
            console.log('⚠️ [Cache Reconstruction] Merge failed, using base artifact as fallback');

            // CRITICAL: Even on fallback, display BASE artifact (not update)
            const baseArtifactFallback = {
              ...baseArtifact,
              content: baseArtifact.content,
            };

            setArtifact(baseArtifactFallback);
            setCurrentArtifactId(baseArtifact.id);

            console.log('✅ [Cache Reconstruction] Set BASE artifact as fallback:', {
              baseArtifactId: baseArtifact.id,
              DISPLAY: 'Base content (merge failed)',
            });

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
        
        // Find the base artifact (non-update) with the same identifier
        const baseArtifact = Object.values(_artifacts).find(
          (a) => a && !a.isUpdate && a.identifier === loadedArtifact.identifier,
        );

        console.log('🔍 [Cache Reconstruction] Base artifact search:', {
          loadedArtifactId: loadedArtifact.id,
          loadedIdentifier: loadedArtifact.identifier,
          loadedIsUpdate: loadedArtifact.isUpdate,
          allArtifacts: Object.values(_artifacts).map((a) => ({
            id: a?.id,
            identifier: a?.identifier,
            isUpdate: a?.isUpdate,
            hasContent: !!a?.content,
            contentLength: a?.content?.length || 0,
          })),
          baseArtifactFound: !!baseArtifact,
          baseArtifactId: baseArtifact?.id,
          baseHasContent: !!baseArtifact?.content,
        });

        if (baseArtifact && baseArtifact.content) {
          // CRITICAL: Verify selection context before applying updates
          console.log('🔍 [Cache Reconstruction] Verifying selection context for update:', {
            updateArtifactId: loadedArtifact.id,
            baseArtifactId: baseArtifact.id,
          });

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

            console.log('🔍 [Cache Reconstruction] Selection context validation:', {
              selectionContext,
              actualText: actualText.substring(0, 100),
              originalText: originalText.substring(0, 100),
              matches: actualText === originalText,
            });

            if (actualText === originalText) {
              console.log(
                '✅ [Cache Reconstruction] Selection context MATCHES - applying update with precision',
              );

              // CRITICAL: Check if loadedArtifact.content is already a FULL MERGED document
              // If it is, DON'T merge it again (would cause duplication)
              // Use content size heuristic instead of format-specific detection
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

              console.log('🔍 [Cache Reconstruction] Content analysis:', {
                loadedContentLength: loadedArtifact.content?.length || 0,
                baseContentLength: baseArtifact.content?.length || 0,
                sizeRatio:
                  (loadedArtifact.content?.length || 0) /
                  Math.max(baseArtifact.content?.length || 1, 1),
                loadedContentIsFullDoc,
                loadedContentIsSameAsBase,
                shouldSkipMerge: loadedContentIsFullDoc && !loadedContentIsSameAsBase,
              });

              // If loaded content is already a full document and different from base,
              // it's probably already merged - use it directly
              if (loadedContentIsFullDoc && !loadedContentIsSameAsBase) {
                console.log('✅ [Cache Reconstruction] Content already merged - using directly');
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
            } else {
              console.warn(
                '⚠️ [Cache Reconstruction] Selection context MISMATCH - base content may have changed',
              );
              console.warn('Expected text:', originalText.substring(0, 100));
              console.warn('Actual text:', actualText.substring(0, 100));
              console.warn('Falling back to full reconstruction...');
            }
          } else {
            console.warn(
              '⚠️ [Cache Reconstruction] No valid selection context found for update artifact',
            );
            console.warn('Falling back to full reconstruction...');
          }

          // Fallback: Use applyAllPartialUpdates to rebuild complete state
          console.log(
            '🔵🔵🔵 [CALL SITE 1: Artifact.tsx Cache Reconstruction] CALLING applyAllPartialUpdates:',
            {
              location: 'Artifact.tsx line ~1098 - Cache Reconstruction (Fallback)',
              reason:
                'Reconstructing merged state after cache load (selection context unavailable/invalid)',
              baseArtifactId: baseArtifact.id,
              targetArtifactId: loadedArtifact.id,
            baseContentLength: baseArtifact.content.length,
              allArtifactsCount: Object.keys(_artifacts).length,
              isStreaming: false,
              conversationId,
              STACK_TRACE: new Error().stack?.split('\n').slice(1, 5).join('\n'),
            },
          );

          const mergedContent = applyAllPartialUpdates(
            baseArtifact.content,
            _artifacts,
            loadedArtifact.id,
            false, // Not streaming - this is a refresh
            conversationId, // Pass conversationId for database sync
          );

          console.log('🎯 [Cache Reconstruction] Merged content result:', {
            mergedContentIsNull: mergedContent === null,
            mergedContentIsUndefined: mergedContent === undefined,
            mergedContentIsEmpty: mergedContent === '',
            mergedContentType: typeof mergedContent,
            mergedContentLength: mergedContent?.length || 0,
            mergedPreview: mergedContent?.substring(0, 200) || 'NO CONTENT',
          });

          // CRITICAL: Check if merge failed (returned null/undefined/empty)
          if (!mergedContent) {
            console.error('❌ [Cache Reconstruction] Merge failed - mergedContent is null/empty!', {
              baseContentLength: baseArtifact.content.length,
              loadedArtifactId: loadedArtifact.id,
              loadedContent: loadedArtifact.content?.substring(0, 100),
            });
            // Fallback: use the loaded artifact's raw content if available
            // or the base artifact content as last resort
            const fallbackContent = loadedArtifact.content || baseArtifact.content;
            console.warn('⚠️ [Cache Reconstruction] Using fallback content:', {
              source: loadedArtifact.content ? 'loadedArtifact' : 'baseArtifact',
              contentLength: fallbackContent?.length || 0,
            });

            const reconstructedArtifact = {
              ...loadedArtifact,
              content: fallbackContent,
            };

            console.log('✅ [Cache Reconstruction] Setting fallback artifact (merge failed)');
            // CRITICAL: Only update LOCAL state to avoid infinite loop
            setArtifact(reconstructedArtifact);
            setCurrentArtifactId(reconstructedArtifact.id);
            // DO NOT call setArtifacts - causes infinite loop!

            // Mark as processed
            lastReconstructedArtifactId.current = _currentArtifactId;
            return;
          }

          // CRITICAL FIX: Display the BASE artifact with merged content, not the update artifact
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

          console.log(
            '✅ [Cache Reconstruction] Set BASE artifact as current with merged content:',
            {
              baseArtifactId: baseArtifact.id,
              updateArtifactId: loadedArtifact.id,
              mergedContentLength: mergedContent.length,
              DISPLAY: 'Showing base WITH all updates applied',
            },
          );

          // Mark this artifact as processed to prevent re-processing
          lastReconstructedArtifactId.current = _currentArtifactId;
          return;
        } else {
          console.warn('⚠️ [Cache Reconstruction] No base artifact found for update artifact');
        }
      }

      console.log('✅ [Cache Reconstruction] Setting loaded artifact (no reconstruction needed)');
      setArtifact(loadedArtifact);
      setCurrentArtifactId(loadedArtifact.id);

      // Mark this artifact as processed
      lastReconstructedArtifactId.current = _currentArtifactId;
    }
  }, [_currentArtifactId, _artifacts, setArtifacts, conversationId, setCurrentArtifactId]);

  // CRITICAL: Keep local artifact state in sync with global artifacts state
  // This ensures that when artifacts are updated during streaming, the local state reflects changes
  // BUT: Don't sync during streaming to prevent duplicate processing
  useEffect(() => {
    if (artifact && _artifacts && _artifacts[artifact.id]) {
      const globalArtifact = _artifacts[artifact.id];

      // Type guard to ensure globalArtifact exists
      if (!globalArtifact) return;

      // Only update if content has actually changed to avoid infinite loops
      if (globalArtifact.content !== artifact.content) {
        // console.log('🔄 [Artifact Sync] Global artifact content changed, syncing to local state:', {
        //   artifactId: artifact.id,
        //   oldLength: artifact.content?.length || 0,
        //   newLength: globalArtifact.content?.length || 0,
        // });
        setArtifact(globalArtifact);
      }
    }
  }, [_artifacts, artifact]);

  // --- Main effect: Process artifact creation and updates ---
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

    const isStreaming = artifactsContext.isSubmitting; // Changed from isStreaming to isSubmitting
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
      // NOTE: lastContent.current is updated INSIDE updateArtifact() after successful processing
      console.log(
        'resetting counter and updating artifact',
        updateKey,
        'hasContent:',
        hasContent,
        'isUpdate:',
        isArtifactUpdateNode,
        'content length:',
        content.length,
        _currentArtifactId,
      );
      resetCounter();
      updateArtifact();
      // } else if (!_currentArtifactId && hasContent) {
      //   // If no artifact is selected (e.g. on refresh), select this one (but only if it has content)
      //   setCurrentArtifactId(artifact?.id ?? null);
    }

    // REMOVED AUTO-SELECTION: Don't automatically select artifacts
    // This was causing artifacts to re-open after user explicitly closed them
    // Users can click the artifact button to open it manually
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
      console.log('[Artifact Sync] Syncing merged artifact to global state:', displayArtifact.id);
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

  // console.log('Rendering Artifact component with displayArtifact:', {
  //   artifactId: artifact?.id,
  //   artifactContentLength: artifact?.content?.length || 0,
  //   artifactIsUpdate: artifact?.isUpdate,
  //   displayArtifactId: displayArtifact?.id,
  //   displayArtifactContentLength: displayArtifact?.content?.length || 0,
  //   currentArtifactId: _currentArtifactId,
  // });

  return <ArtifactButton artifact={artifact} />;
}

// Selection component to parse and save selection context BEFORE artifact updates
function SelectionComponent({
  node,
  selectionText: propsSelectionText,
}: {
  node: unknown;
  children?: React.ReactNode;
  selectionText?: string; // This comes from hProperties
}) {
  const { messageId } = useMessageContext();
  const artifactsContext = useArtifactsContext();
  const location = useLocation();
  const [_artifacts] = useRecoilState(artifactsState); // Get current artifacts

  // CRITICAL: Multiple fallback strategies to ALWAYS get conversationId
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
      console.log('📍 [Selection] Got conversationId from search params:', searchConvId);
      return searchConvId;
    }

    // Strategy 4: Try to get from any existing artifact in the current message
    const artifactsArray = _artifacts ? Object.values(_artifacts) : [];
    const recentArtifact = artifactsArray.find((a) => a?.messageId === messageId);
    if (recentArtifact && (recentArtifact as any).conversationId) {
      console.log(
        '📍 [Selection] Got conversationId from existing artifact:',
        (recentArtifact as any).conversationId,
      );
      return (recentArtifact as any).conversationId;
    }

    console.error('❌ [Selection] Could not determine conversationId from any source!', {
      contextId: artifactsContext.conversationId,
      pathname: location.pathname,
      search: location.search,
      messageId,
    });
    return null;
  }, [artifactsContext.conversationId, location.pathname, location.search, messageId, _artifacts]);

  useEffect(() => {
    console.log('🔍 [SelectionComponent] Component mounted/updated', {
      messageId,
      conversationId,
      nodeType: (node as any)?.type,
      hasData: !!(node as any)?.data,
      hasSelectionText: !!(node as any)?.data?.selectionText,
      hasPropsSelectionText: !!propsSelectionText,
      CRITICAL: 'Should use propsSelectionText from hProperties',
    });

    // CRITICAL FIX: Use propsSelectionText from hProperties, NOT node.data
    // ReactMarkdown doesn't preserve node.data but DOES pass hProperties as props
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

    console.log('📍 [Selection] Parsing selection directive:', {
      messageId,
      conversationId,
      selectionTextLength: selectionText.length,
      selectionTextPreview: selectionText.substring(0, 200),
      fullText: selectionText,
    });

    // Parse the selection text
    // Expected format:
    // Location of update:
    // - originalText: "..."
    // - startLine: 13
    // - endLine: 13
    // - startColumn: 0
    // - endColumn: 0

    // CRITICAL: Try multiple regex patterns to handle different text formats
    // Pattern 1: Standard format with quotes: originalText: "text"
    // Pattern 2: Alternative format: - originalText: "text"
    const originalTextMatch =
      selectionText.match(/(?:^|\n)\s*-?\s*originalText:\s*"([^"]*)"/m) ||
      selectionText.match(/originalText:\s*"([^"]*)"/);

    const startLineMatch =
      selectionText.match(/(?:^|\n)\s*-?\s*startLine:\s*(\d+)/m) ||
      selectionText.match(/startLine:\s*(\d+)/);

    const endLineMatch =
      selectionText.match(/(?:^|\n)\s*-?\s*endLine:\s*(\d+)/m) ||
      selectionText.match(/endLine:\s*(\d+)/);

    const startColumnMatch =
      selectionText.match(/(?:^|\n)\s*-?\s*startColumn:\s*(\d+)/m) ||
      selectionText.match(/startColumn:\s*(\d+)/);

    const endColumnMatch =
      selectionText.match(/(?:^|\n)\s*-?\s*endColumn:\s*(\d+)/m) ||
      selectionText.match(/endColumn:\s*(\d+)/);

    console.log('🔍 [Selection] Regex match results:', {
      originalTextMatch: originalTextMatch ? originalTextMatch[1] : 'NO MATCH',
      startLineMatch: startLineMatch ? startLineMatch[1] : 'NO MATCH',
      endLineMatch: endLineMatch ? endLineMatch[1] : 'NO MATCH',
      startColumnMatch: startColumnMatch ? startColumnMatch[1] : 'NO MATCH',
      endColumnMatch: endColumnMatch ? endColumnMatch[1] : 'NO MATCH',
      RAW_FULL_TEXT: selectionText,
      TEXT_LINES: selectionText.split('\n').map((line, i) => `Line ${i}: "${line}"`),
    });

    if (!startLineMatch || !endLineMatch || !startColumnMatch || !endColumnMatch) {
      console.error('❌ [Selection] Failed to parse required fields from selection text', {
        selectionText,
        EXPECTED_FORMAT: [
          'Location of update:',
          '- originalText: "text"',
          '- startLine: 13',
          '- endLine: 13',
          '- startColumn: 0',
          '- endColumn: 0',
        ].join('\n'),
      });
      return;
    }

    const selectionContext = {
      originalText: originalTextMatch ? originalTextMatch[1] : '',
      startLine: parseInt(startLineMatch[1], 10),
      endLine: parseInt(endLineMatch[1], 10),
      startColumn: parseInt(startColumnMatch[1], 10),
      endColumn: parseInt(endColumnMatch[1], 10),
      artifactMessageId: messageId,
      fileKey: `artifact_${messageId}`, // Required field for ArtifactSelectionContext
    };

    console.log('✅ [Selection] Parsed selection context:', {
      ...selectionContext,
      CRITICAL_CHECK: {
        originalTextLength: selectionContext.originalText.length,
        isEmptyOriginalText: selectionContext.originalText === '',
        isAddition: selectionContext.originalText === '' && selectionContext.startLine > 0,
        isReplacement: selectionContext.originalText !== '',
        lineRange: `${selectionContext.startLine}-${selectionContext.endLine}`,
        columnRange: `${selectionContext.startColumn}-${selectionContext.endColumn}`,
      },
    });

    // CRITICAL: The artifactId will be determined by the NEXT artifactupdate directive
    // We need to store this temporarily and associate it when artifactupdate comes
    // Store in a temporary location that Artifact component can access

    // Strategy: Use sessionStorage with messageId as key
    // The Artifact component will read this when processing artifactupdate
    const storageKey = `selection_pending_${messageId}`;
    sessionStorage.setItem(storageKey, JSON.stringify(selectionContext));

    console.log('💾 [Selection] Stored pending selection in sessionStorage:', {
      key: storageKey,
      context: selectionContext,
      NEXT_STEP: 'Artifact component will read this when processing artifactupdate',
    });

    // Also try to find the most recent artifactupdate that might be associated
    // by looking for artifacts with the same messageId
    // This handles the case where selection comes AFTER artifactupdate in streaming
    const relatedArtifacts = _artifacts
      ? Object.values(_artifacts).filter(
          (item: any) => item?.messageId === messageId && item?.isUpdate === true,
        )
      : [];

    console.log('🔍 [Selection] Searching for related update artifacts:', {
      messageId,
      totalArtifacts: _artifacts ? Object.keys(_artifacts).length : 0,
      relatedArtifactsFound: relatedArtifacts.length,
      relatedArtifactIds: relatedArtifacts.map((a) => a?.id),
    });

    // CRITICAL: DO NOT save to database here - wait for streaming to complete!
    // The selection is saved to sessionStorage above, and will be:
    // 1. Read by Artifact component when artifactupdate arrives
    // 2. Saved to database ONLY when streaming completes
    // This matches the flow for artifactupdate content

    if (relatedArtifacts.length > 0) {
      console.log('🔍 [Selection] Found related update artifacts (already created):', {
        count: relatedArtifacts.length,
        artifacts: relatedArtifacts.map((a: any) => ({ id: a.id, identifier: a.identifier })),
        NOTE: 'Selection is in sessionStorage - will be saved to database when streaming completes',
      });
    } else {
      console.log(
        '⏳ [Selection] No update artifacts found yet - selection arrived BEFORE artifactupdate',
        {
          messageId,
          sessionStorageKey: storageKey,
          NOTE: 'Waiting for artifactupdate directive to arrive and streaming to complete',
        },
      );
    }
  }, [node, messageId, conversationId, _artifacts, propsSelectionText]);

  // Don't render anything visible
  return null;
}

// Export the main Artifact component as ArtifactUpdate for backward compatibility
// Both artifact and artifactupdate directives now use the same component
export const ArtifactUpdate = Artifact;
export const Selection = SelectionComponent;
