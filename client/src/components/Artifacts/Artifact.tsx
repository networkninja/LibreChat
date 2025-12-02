import React, { useEffect, useCallback, useRef, useState } from 'react';
import { visit } from 'unist-util-visit';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext, useArtifactsContext } from '~/Providers';
import { artifactsState } from '~/store/artifacts';
import { extractNodes, extractContent } from '~/utils';
import ArtifactButton from './ArtifactButton';
import { artifactCache } from './ArtifactCache';
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

  // Removed unused variable artifactIndex

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
  const pendingCacheUpdates = useRef<Map<string, { content: string; metadata: any }>>(new Map()); 
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
    const isNowComplete = !artifactsContext.isSubmitting;

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
          let hasUpdates = false;

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

            console.log('🔄 [Artifact] Checking RECENT update artifact for final merge:', {
              artifactId,
              isUpdate: artifact.isUpdate,
              isMerged: artifact.isMerged,
              age: artifactAge,
              contentLength: artifact.content?.length || 0,
              contentPreview: artifact.content?.substring(0, 100),
              WILL_PROCESS: true,
              CRITICAL: 'This is a RECENT update from the current streaming session',
            });

            // Process this recent update artifact

            // Find the base artifact for this update
            const baseArtifact = Object.values(updatedArtifacts).find(
              (a) => a && !a.isUpdate && a.identifier === artifact.identifier,
            );

            if (baseArtifact && baseArtifact.content) {
              console.log('🔀 [Artifact] Applying FINAL merge after streaming complete:', {
                updateArtifactId: artifactId,
                baseArtifactId: baseArtifact.id,
                currentContentLength: artifact.content?.length || 0,
                baseLength: baseArtifact.content.length,
                wasAlreadyMerged: artifact.isMerged,
                CRITICAL: 'This is the definitive merge - streaming is complete',
              });

              // Apply the merge
              const mergedContent = applyPartialUpdate(
                baseArtifact.content,
                artifact.content || '',
                artifactId,
                0,
                updatedArtifacts,
              );

              if (mergedContent && mergedContent !== baseArtifact.content) {
                console.log('✅✅✅ [Artifact] FINAL MERGE SUCCESSFUL:', {
                  artifactId,
                  currentContentLength: artifact.content?.length || 0,
                  finalMergedLength: mergedContent.length,
                  isFullDocument:
                    mergedContent.includes('<!DOCTYPE') || mergedContent.includes('<html'),
                  CRITICAL: 'Artifact now contains complete merged document',
                });

                updatedArtifacts[artifactId] = {
                  ...artifact,
                  content: mergedContent, // Replace with final merged content
                  isMerged: true, // Mark as fully merged (streaming complete)
                };
                hasUpdates = true;
              } else if (mergedContent === baseArtifact.content) {
                console.warn(
                  '⚠️ [Artifact] Merge returned unchanged base - no selection context?',
                  {
                    artifactId,
                    baseLength: baseArtifact.content.length,
                    snippetLength: artifact.content?.length || 0,
                  },
      );
              }
            } else {
              console.warn('⚠️ [Artifact] No base artifact found for update:', {
                updateArtifactId: artifactId,
                identifier: artifact.identifier,
                ISSUE: 'Cannot merge without base artifact',
              });
            }
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

      // Process all pending cache updates
      if (pendingCacheUpdates.current.size > 0) {
      pendingCacheUpdates.current.forEach((update, artifactId) => {
          console.log('💾 [Artifact] Saving pending update to cache:', artifactId, {
            conversationId,
            hasConversationId: !!conversationId,
            contentLength: update.content?.length || 0,
            contentPreview: update.content?.substring(0, 200) || 'NO CONTENT',
            isFullDocument:
              update.content?.includes('<!DOCTYPE') || update.content?.includes('<html>'),
            metadata: update.metadata,
            FULL_CONTENT: update.content, // LOG ENTIRE CONTENT BEING SAVED
          });

          // CRITICAL: Pass conversationId in metadata for database sync
          artifactCache.setContent(artifactId, update.content, {
            ...update.metadata,
            conversationId: conversationId || undefined, // Add conversationId for database sync
          });

          console.log('✅ [Artifact] Cache save completed for:', artifactId);
      });

      // Clear the pending updates
      pendingCacheUpdates.current.clear();

      // CRITICAL: Flush any pending database syncs immediately after streaming completes
      // This ensures all debounced writes happen now instead of waiting for the timer
      console.log('🌊 [Artifact] Flushing pending database syncs...');
      artifactCache.flushPendingSyncs().then(() => {
        console.log('✅ [Artifact] All database syncs completed');
      });
    }

    // Track previous streaming state
    lastIsSubmittingRef.current = artifactsContext.isSubmitting;
  }, [artifactsContext.isSubmitting, conversationId, setArtifacts]);

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
        // console.log('✅ Using code from node.data.extractedCode:', {
        //   contentLength: content.length,
        //   contentPreview: content.substring(0, 200),
        //   VALIDATION: {
        //     hasGeorgia: content.includes('font-family: Georgia'),
        //     hasPreviousColor: content.includes('color: #2c3e50'),
        //   },
        // });
      }
    }

    if (!content) {
      // Strategy 2: Extract from code block in children
      function findCodeBlock(node: any): string | null {
        if (!node) return null;

        // Direct code node with value property (from markdown AST)
        if (node.type === 'code' && typeof node.value === 'string') {
          console.log('✅ Found code node with value');
          return node.value;
        }

        // React code element
        if (node.props) {
          const isCodeElement = 
            node.type === 'code' || 
            (typeof node.props.className === 'string' &&
              node.props.className.includes('language-'));

          if (isCodeElement && typeof node.props.children === 'string') {
            console.log('✅ Found React code element');
            return node.props.children;
          }

          // Recursively search props.children
          if (node.props.children) {
            const found = findCodeBlock(node.props.children);
            if (found) return found;
          }
        }

        // Search array of children
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = findCodeBlock(child);
          if (found) return found;
          }
        }

        // Search children property
        if (node.children) {
          const found = findCodeBlock(node.children);
          if (found) return found;
        }

        return null;
      }

      const codeContent = findCodeBlock(props.children);
      if (codeContent) {
        content = codeContent;
        console.log('✅ Extracted from code block in children:', content.length, 'chars');
      } else {
        // Last resort fallback
        content = extractContent(props.children);
        console.warn(
          '⚠️ No code block found, using extractContent (may cause duplication):',
          content.length,
          'chars',
        );
      }
    }

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
      REASON: isArtifactUpdateNode
        ? 'Explicit <artifactupdate> tag'
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

        // Use the most recent artifact's content (whether it's base or an update)
        const baseContent = mostRecentArtifact?.content || existingArtifact.content || '';
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

        // CRITICAL FIX: Only perform merge when streaming is COMPLETE
        // During streaming, just accumulate the content in the update artifact
        // This prevents character-by-character merges that cause duplication
        const _isStreaming = artifactsContext?.isSubmitting;
        let noMergeHappened = false;

        if (_isStreaming) {
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
          0,
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

        console.log('🔍 [Artifact] Selection search results:', {
          strategyMessageId: {
            count: matchingByMessageId.length,
            selections: matchingByMessageId.map(([k, v]) => ({
              key: k,
              messageId: v.artifactMessageId,
              timestamp: v.timestamp,
            })),
          },
          strategyIdentifier: {
            count: matchingByIdentifier.length,
            selections: matchingByIdentifier.map(([k, v]) => ({
              key: k,
              messageId: v.artifactMessageId,
              timestamp: v.timestamp,
            })),
          },
        });

        // Use messageId match if found, otherwise fall back to most recent by identifier
        const matchingSelections =
          matchingByMessageId.length > 0 ? matchingByMessageId : matchingByIdentifier;
        
        const sourceSelectionContext =
          matchingSelections.length > 0 ? matchingSelections[0][1] : null;
        
        if (sourceSelectionContext) {
          console.log('✅ [Artifact] Found selection context for this update:', {
            sourceKey: matchingSelections[0][0],
            strategy: matchingByMessageId.length > 0 ? 'messageId' : 'identifier+timestamp',
            startLine: sourceSelectionContext.startLine,
            endLine: sourceSelectionContext.endLine,
            startColumn: sourceSelectionContext.startColumn,
            endColumn: sourceSelectionContext.endColumn,
            originalText: sourceSelectionContext.originalText?.substring(0, 100),
            CURRENT_CONTENT: content.substring(0, 100),
          });
          
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
        pendingCacheUpdates.current.set(updateArtifact.id, {
          content: finalContent, // Save full merged content, not just snippet
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
          pendingCacheUpdates.current.set(existingArtifact.id, {
            content: finalContent, // Save full merged content to base artifact cache
            metadata: {
              title: existingArtifact.title,
              type: existingArtifact.type,
              identifier: existingArtifact.identifier,
              source: 'directive',
            },
          });
          console.log('📝 [Artifact] Queued cache save for BASE artifact:', {
            artifactId: existingArtifact.id,
            contentLength: finalContent.length,
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

        console.log('🔍 Streaming state check:', {
          isStreaming: artifactsContext.isSubmitting,
          updateArtifactKey,
          snippetLength: updateArtifact.content?.length || 0,
          mergedLength: finalContent.length,
          noMergeHappened,
          WILL_SAVE: 'MERGED CONTENT (always)',
        });

        const displayArtifact = {
          ...updateArtifact,
          content: finalContent, // ALWAYS use merged content for display
          isMerged: !artifactsContext.isSubmitting && !noMergeHappened, // Only mark as merged if merge succeeded
        };

        setArtifacts((prevArtifacts) => {
          console.log('💾 [Artifact] Storing artifact with MERGED CONTENT:', updateArtifactKey, {
            snippetLength: updateArtifact.content?.length || 0,
            mergedLength: finalContent.length,
            isStreaming: artifactsContext.isSubmitting,
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
    
    // Generate the artifact key
    const artifactKey = `${identifier}_${type}_${title}_${messageId}`
      .replace(/\s+/g, '_')
      .toLowerCase();

    // Mark this artifact as streaming so cache updates are queued
    //markArtifactStreaming(artifactKey);
    
    console.log('🔍 Proceeding with regular artifact creation for artifactKey:', artifactKey);
    
    // CRITICAL: Don't throttle state updates - React batches them efficiently
    // Throttling causes streaming chunks to be dropped, making updates appear jumpy
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
    artifactsContext.isSubmitting,
    _artifacts,
    isArtifactUpdateNode,
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

      if (hasSubstantialContent || isRecentlyCreated) {
        console.log(
          '✅ [Cache Reconstruction] Artifact is NEW UPDATE - SKIP cache reconstruction',
          {
            artifactId: loadedArtifact.id,
            contentLength: loadedArtifact.content?.length || 0,
            isCorrupted,
            hasSubstantialContent,
            isRecentlyCreated,
            artifactAge: loadedArtifact.lastUpdateTime
              ? Date.now() - loadedArtifact.lastUpdateTime
              : 'unknown',
            DECISION: 'Use state content directly, no cache reconstruction needed',
          },
        );
        setArtifact(loadedArtifact);
        lastReconstructedArtifactId.current = _currentArtifactId;
        return;
      }

      console.log(
        '🔄 [Cache Reconstruction] Artifact needs reconstruction - PAGE REFRESH detected',
        {
          artifactId: loadedArtifact.id,
        hasContent: !!loadedArtifact.content,
        contentLength: loadedArtifact.content?.length || 0,
          isCorrupted,
          hasSubstantialContent,
          REASON: 'Content missing, too short, or corrupted - likely page refresh',
        },
      );

      // ========== STEP 1: ALWAYS CHECK CACHE FIRST (FASTEST PATH) ==========
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
        console.log(
          '🎯✅✅✅ [Cache Reconstruction] CACHE HIT! Using cached content directly - NO MERGE NEEDED!',
          {
            artifactId: loadedArtifact.id,
            cachedContentLength: cachedContent.content.length,
            cacheAge: Date.now() - (cachedContent.timestamp || 0),
            PERFORMANCE: '⚡ FASTEST PATH - Direct cache use',
          },
        );
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
    let content = extractContent(props.children);
    const extracted = extractNodes(props.children);

    // console.log('🔍 [Artifact useEffect] Entry:', {
    //   isArtifactUpdateNode,
    //   propsIdentifier: props.identifier,
    //   propsType: props.type,
    //   propsTitle: props.title,
    //   messageId,
    //   hasPropsChildren: !!props.children,
    //   contentFromExtractContent: content?.substring(0, 100),
    //   extractedNodes: extracted,
    // });

    if (!content) {
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
      } else {
        content = '';
      }
    }

    // For artifact updates: Always update to merge continuously, even with empty content
    // For regular artifacts: Only update if there's actual content
    const hasContent = content && content.trim() !== '';
    const shouldProcess = isArtifactUpdateNode || hasContent;

    // Check if incoming content is a full document (should always be processed, not deduplicated)
    const isFullDoc = /<!DOCTYPE|<html|<head>|<body>/i.test(content);

    // CRITICAL: Process artifact updates when:
    // 1. Streaming just completed (transition from true to false)
    // 2. Not streaming AND content is different from last processed
    // 3. Not streaming AND this is first time seeing this content
    const isStreaming = artifactsContext.isSubmitting;
    const wasStreaming = lastIsSubmittingRef.current;
    const streamingJustCompleted = wasStreaming && !isStreaming;

    const shouldUpdate =
      shouldProcess &&
        (isArtifactUpdateNode
        ? // For updates: Process when:
          // 1. Streaming just completed
          (streamingJustCompleted && hasContent) ||
          // 2. Content changed while not streaming
          (!isStreaming && lastContent.current !== content && hasContent) ||
          // 3. First time seeing content (lastContent not set)
          (!isStreaming && !lastContent.current && hasContent) ||
          // 4. After page refresh - we have content but haven't processed this message yet
          (!isStreaming && hasContent && lastProcessedMessageId.current !== messageId)
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
    } else if (!_currentArtifactId && hasContent) {
      // If no artifact is selected (e.g. on refresh), select this one (but only if it has content)
      setCurrentArtifactId(artifact?.id ?? null);
    } else {
      console.log(
        'skipping updateArtifact - shouldUpdate:',
        shouldUpdate,
        'shouldProcess:',
        shouldProcess,
        'hasContent:',
        hasContent,
        'isUpdate:',
        isArtifactUpdateNode,
      );
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

// Export the main Artifact component as ArtifactUpdate for backward compatibility
// Both artifact and artifactupdate directives now use the same component
export const ArtifactUpdate = Artifact;
