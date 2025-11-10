import React, { useEffect, useCallback, useRef, useState } from 'react';
import throttle from 'lodash/throttle';
import { visit } from 'unist-util-visit';
import { useRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext } from '~/Providers';
import { artifactsState } from '~/store/artifacts';
import { extractNodes, extractContent } from '~/utils';
import ArtifactButton from './ArtifactButton';
import { artifactCache } from './artifactCache';
import store from '~/store';
import { applyAllPartialUpdates } from '~/hooks/Artifacts/useArtifactUtlis';
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

      // For artifactupdate nodes, check if we need to preserve existing artifact properties
      if (node.name === 'artifactupdate' && extractedAttributes.identifier) {
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
          // Update the artifact cache with the new content for this update
          artifactCache.setContent(extractedAttributes.identifier, codeBlock, {
            title: extractedAttributes.title || '',
            type: extractedAttributes.type || '',
            identifier: extractedAttributes.identifier,
            source: 'directive',
          });
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

  console.log('Artifact node analysis:', { node, nodeTag, nodeType });

  const isArtifactUpdateNode =
    nodeTag === 'artifactupdate' || (nodeType === 'element' && nodeTag === 'artifactupdate');

  const location = useLocation();
  const { messageId, message } = useMessageContext();
  const { resetCounter } = useArtifactContext();

  const [_artifacts, setArtifacts] = useRecoilState(artifactsState);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [_visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const [_currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const lastUpdateKey = useRef<string | null>(null);
  const lastContent = useRef<string | null>(null);
  const [_refreshTrigger, setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);
  let displayArtifact;

  const throttledUpdateRef = useRef(
    throttle((updateFn: () => void) => {
      updateFn();
    }, 25),
  );

  const getFirstArtifactInChain = useCallback(
    (identifier: string) => {
      console.log('first artifact in chain called with identifier', identifier, _artifacts);
      if (!_artifacts) return { key: null, artifact: null };
      const candidateKeys = Object.keys(_artifacts).filter((key) => {
        const existingArtifact = _artifacts[key];
        // Match if identifier starts with the base identifier and is not an update
        return (
          typeof existingArtifact?.identifier === 'string' &&
          existingArtifact.identifier.startsWith(identifier) &&
          !existingArtifact.isUpdate
        );
      });
      if (candidateKeys.length > 0) {
        // Sort by lastUpdateTime ascending (oldest first)
        candidateKeys.sort((a, b) => {
          const artifactA = _artifacts[a];
          const artifactB = _artifacts[b];
          const timeA = artifactA?.lastUpdateTime || 0;
          const timeB = artifactB?.lastUpdateTime || 0;
          return timeA - timeB;
        });
        console.log('candidateKeys after sorting:', candidateKeys);
        // Return the first original artifact
        return { key: candidateKeys[0], artifact: _artifacts[candidateKeys[0]] };
      }
      return { key: null, artifact: null };
    },
    [_artifacts],
  );

  // Helper: is the artifact update fully loaded?
  function isFullyLoadedMessage(msg: any) {
    if (!msg) return false;
    if (typeof msg.content === 'string') {
      // Heuristic: LLMs often end with ::: or similar marker
      return msg.content.includes(':::') || msg.content.includes('END') || msg.content.length > 100;
    }
    if (Array.isArray(msg.content)) {
      return msg.content.some(
        (item: any) =>
          typeof item.text === 'string' && (item.text.includes(':::') || item.text.includes('END')),
      );
    }
    return false;
  }

  // Always use the most recent artifact in the chain for updates
  const updateArtifact = useCallback(() => {
    // Use extractNodes for robust extraction
    let content = extractContent(props.children);
    // Fallbacks if content is empty/null
    if (!content || content.trim() === '') {
      // Try artifact content, message text, or scan for any non-empty string in children
      content = artifact?.content || message?.text || '';
      if (!content || content.trim() === '') {
        // Recursively search for any non-empty string in deeply nested children
        function findNonEmptyContent(node: any): string {
          if (!node) return '';
          if (typeof node === 'string' && node.trim() !== '') return node;
          if (Array.isArray(node)) {
            for (const child of node) {
              const found = findNonEmptyContent(child);
              if (found && found.trim() !== '') return found;
            }
          }
          if (node.props && node.props.children) {
            return findNonEmptyContent(node.props.children);
          }
          if (node.children) {
            return findNonEmptyContent(node.children);
          }
          return '';
        }
        content = findNonEmptyContent(props.children) || '';
      }
    }

    const title = props.title ? props.title : defaultTitle;
    const type = props.type ?? defaultType;
    const identifier = props.identifier ?? defaultIdentifier;

    // Extract markdown content from the message
    const markdownContent = message?.text || content;
    // Regular :::artifact blocks should always create new artifacts, even with same identifier
    const shouldUpdate = isArtifactUpdateNode && identifier && identifier !== defaultIdentifier;
    // Only merge if fully loaded, otherwise show raw/previous content
    // ...inside updateArtifact...

    // Only merge if fully loaded, otherwise show raw/previous content
    let finalContent = content;
    const fullyLoaded = isFullyLoadedMessage(message);

    if (shouldUpdate && fullyLoaded) {
      // Only merge when fully loaded
      if (artifact && _artifacts && artifact.identifier) {
        const isUpdatedArtifact = artifact.isUpdate;
        let baseIdentifier = artifact.identifier;
        if (isUpdatedArtifact) {
          baseIdentifier = artifact.identifier.split('_')[0];
        }
        const baseArtifact = Object.values(_artifacts).find(
          (a: any) => a.identifier && a.identifier.startsWith(baseIdentifier) && !a.isUpdate,
        );
        if (
          baseArtifact &&
          Object.keys(_artifacts).length !== 0 &&
          artifact.content !== baseArtifact.content
        ) {
          finalContent = applyAllPartialUpdates(
            baseArtifact.content ?? artifact.content ?? '',
            _artifacts,
            artifact.id,
          );
        }
      }
    }

    // ...use finalContent for artifact creation/update...
    // if (shouldUpdate && fullyLoaded) {
    //   // Only merge when fully loaded
    //   if (artifact && _artifacts && artifact.identifier) {
    //     const isUpdatedArtifact = artifact.isUpdate;
    //     let baseIdentifier = artifact.identifier;
    //     if (isUpdatedArtifact) {
    //       baseIdentifier = artifact.identifier.split('_')[0];
    //     }
    //     const baseArtifact = Object.values(_artifacts).find(
    //       (a: any) => a.identifier && a.identifier.startsWith(baseIdentifier) && !a.isUpdate,
    //     );
    //     if (
    //       baseArtifact &&
    //       Object.keys(_artifacts).length !== 0 &&
    //       artifact.content !== baseArtifact.content
    //     ) {
    //       finalContent = applyAllPartialUpdates(
    //         baseArtifact.content ?? artifact.content ?? '',
    //         _artifacts,
    //         artifact.id,
    //       );
    //     }
    //   }
    // }

    if (shouldUpdate) {
      // Always ensure the base/original artifact is present in _artifacts
      let baseArtifactKey: string | null = null;
      let baseArtifact: Artifact | null = null;
      const mostRecent = getFirstArtifactInChain(identifier);
      if (mostRecent.key && mostRecent.artifact) {
        baseArtifact = mostRecent.artifact;
        baseArtifactKey = mostRecent.key;
      } else {
        // If not found, create and record a base artifact
        baseArtifactKey = `${identifier}_${type}_${title}_${messageId}`
          .replace(/\s+/g, '_')
          .toLowerCase();
        baseArtifact = {
          id: baseArtifactKey,
          identifier,
          title,
          type,
          content: content, // Use the current content as the base
          messageId,
          index: 0,
          lastUpdateTime: Date.now(),
          isUpdate: false, // CRITICAL: Base artifact is NEVER an update
        };
        console.log('baseArtifact', baseArtifact);
        setArtifacts((prevArtifacts) => ({
          ...prevArtifacts,
          [baseArtifactKey as string]: baseArtifact as Artifact,
        }));
      }

      console.log('🔄 Processing artifact UPDATE for identifier:', identifier);
      // CRITICAL: Use the currently selected artifact as the base for updates
      // This allows chaining updates from any selected artifact (original or updated)
      let existingArtifactKey: string | null = null;
      console.log('identifier', identifier, _artifacts);
      // Always use the most recent artifact in the chain for updates
      const mostRecentUpdate = getFirstArtifactInChain(identifier);
      console.log('most Recent', mostRecentUpdate);
      if (mostRecentUpdate.key && mostRecentUpdate.artifact) {
        baseArtifact = mostRecentUpdate.artifact;
        existingArtifactKey = mostRecentUpdate.key;
        console.log('🔄 [Artifact] Using most recent artifact in chain for update:', {
          foundKey: existingArtifactKey,
          title: baseArtifact?.title,
          foundIdentifier: baseArtifact?.identifier,
        });
      } else {
        existingArtifactKey = null;
        baseArtifact = null;
      }

      console.log(
        'existingArtifactKey:',
        existingArtifactKey,
        '_artifacts keys:',
        Object.keys(_artifacts || {}),
        'baseArtifact:',
        baseArtifact,
      );

      if (baseArtifact) {
        const existingArtifact = baseArtifact;
        console.log('baseArtifact', baseArtifact, artifact?.content);
        console.log('✅ Found existing artifact to update:', existingArtifact.title);
        console.log('🔒 Original artifact preserved:', {
          id: existingArtifact.id,
          title: existingArtifact.title,
          contentLength: existingArtifact.content?.length,
          lastUpdateTime: existingArtifact.lastUpdateTime,
        });
        let updateKey = `${props.identifier}_${props.type}_${props.title}_${messageId}`;
        updateKey = updateKey.replace(/\s+/g, '_').toLowerCase();
        console.log('Generated updateKey for artifact cache:', updateKey);
        // Get comprehensive cache status for this artifact
        const cacheStatus = artifactCache.getStatus(updateKey);
        const cachedContent = artifactCache.getContent(updateKey);
        const cachedSelection = artifactCache.getSelection(updateKey);
        const cachedLocation = artifactCache.getUpdateLocation(updateKey);

        // console.log(
        //   '🔍 [Artifact] Attempting to read cached selection for artifact:',
        //   existingArtifact.id,
        // );
        console.log(
          '📄 Cache status:',
          cacheStatus,
          'cache selection:',
          cachedSelection,
          'cache content',
          cachedContent,
          'cache location:',
          cachedLocation,
        );

        // Debug: Add detailed artifact ID tracing
        console.log('🔍 Artifact ID debugging:', {
          existingArtifactId: existingArtifact.id,
          existingArtifactKey: existingArtifactKey,
          identifier: identifier,
          messageId: messageId,
          title: title,
          type: type,
        });

        const extractCodeBlocks = (markdown: string): string[] => {
          const codeBlockRegex = /```(?:\w+)?\n?([\s\S]*?)```/g;
          const matches: string[] = [];
          let match;
          while ((match = codeBlockRegex.exec(markdown)) !== null) {
            matches.push(match[1].trim());
          }
          return matches;
        };

        const codeBlocks = extractCodeBlocks(markdownContent);
        console.log('codeBlocks', codeBlocks);
        console.log('📝 Markdown content available:', {
          hasMarkdown: markdownContent,
          markdownLength: markdownContent.length,
          codeBlocksFound: codeBlocks.length,
          markdownPreview: markdownContent.substring(0, 200) + '...',
        });

        // Only use code blocks or markdown for partial updates with valid selection context
        const existingContentLength = existingArtifact?.content?.length || 0;

        // Fix: Type narrowing for message and formatting for ternary
        let isFullArtifactUpdate = false;
        if (typeof message === 'string' && message) {
          isFullArtifactUpdate = (message as string).includes(':::artifactupdate');
        } else if (Array.isArray(message?.content)) {
          isFullArtifactUpdate = message.content.some(
            (item: any) =>
              item.type === 'text' &&
              typeof item.text === 'string' &&
              item.text.includes(':::artifactupdate'),
          );
        }

        let isFullElement = false;
        // Check if content is a full HTML, React, or Mermaid element
        if (typeof content === 'string') {
          const trimmed = content.trim();
          // Simple checks for full HTML, React, or Mermaid blocks
          isFullElement =
            /^<([a-zA-Z]+)([^<]+)*(?:>(.*)<\/\1>|\s+\/>)$/.test(trimmed) || // HTML/React JSX
            trimmed.startsWith('<div') ||
            trimmed.startsWith('<section') ||
            trimmed.startsWith('<main') ||
            trimmed.startsWith('<html') ||
            trimmed.startsWith('<body') ||
            trimmed.startsWith('<Mermaid') ||
            trimmed.startsWith('graph ') ||
            trimmed.startsWith('sequenceDiagram') ||
            trimmed.startsWith('stateDiagram') ||
            trimmed.startsWith('classDiagram') ||
            trimmed.startsWith('erDiagram') ||
            trimmed.startsWith('flowchart');
        }
        // If not a full element, treat as update
        const isPartialUpdate = !isFullElement;
        console.log('isFullElement', isFullElement, isPartialUpdate);

        console.log('🔍 Enhanced update analysis:', {
          isFullArtifactUpdate,
          isPartialUpdate,
          newContentLength: existingArtifact?.content?.length,
          existingContentLength,
          cachedSelection: cachedSelection,
          content: content,
          hasCodeBlocks: codeBlocks.length,
          hasValidCachedContent: cacheStatus.contentValid,
          hasValidSelection: cacheStatus.selectionValid,
          existingArtifactcontent: existingArtifact.content,
        });

        // If we have valid cached selection context and this doesn't look like a full replacement
        if (!isFullArtifactUpdate && isPartialUpdate && cachedSelection) {
          const baseContent = cachedContent?.content || existingArtifact.content || '';
          console.log('baseContent', baseContent);
          finalContent = applyAllPartialUpdates(baseContent, _artifacts, existingArtifact.id);
          console.log('finalContent after applyPartialUpdate:', finalContent);
          // if (artifact) {
          //   artifact.content = finalContent;
          // }
        } else if (codeBlocks.length > 0) {
          console.log('codeBlocks', codeBlocks);
          // If we have a code block, always use it as the new content for the update
          finalContent = codeBlocks[0];
        } else {
          console.log('📄 Using full content replacement - caching full content', finalContent);
          finalContent = content;
        }

        // Only cache the final content if this was a full update
        const currentUpdateLocation = artifactCache.getUpdateLocation(existingArtifact.id);
        const shouldCacheContent =
          !currentUpdateLocation || currentUpdateLocation.updateType === 'full';
        console.log('shouldCacheContent', shouldCacheContent);
        if (shouldCacheContent) {
          console.log('💾 Caching final content for full update');
          artifactCache.setContent(existingArtifact.id, finalContent, {
            title: title,
            type: type,
            identifier: identifier,
            source: 'directive',
          });
          console.log('💾 Cached final content for full update');
        } else {
          console.log('🚫 Skipping content cache for partial update');
        }

        // CREATE SEPARATE UPDATED ARTIFACT: Keep original + create new updated version
        console.log('🔄 [Artifact] Creating separate updated artifact alongside original');

        let updatedIdentifier = `${props.identifier}_${props.type}_${props.title}_${messageId}`;
        updatedIdentifier = updatedIdentifier.toLowerCase().replace(/\s+/g, '_');
        console.log('updatedIdentifier', updatedIdentifier);
        const baseTitle = existingArtifact.title;
        const updatedTitle = `${baseTitle}`;

        // Use identifier as key for updated artifacts
        const updatedArtifact: Artifact = {
          ...existingArtifact,
          id: updatedIdentifier, // id and identifier are the same for updated artifacts
          identifier: updatedIdentifier,
          title: updatedTitle,
          content: finalContent,
          lastUpdateTime: Date.now(),
          isUpdate: true,
        };

        console.log('updatedArtifact', updatedArtifact);

        // CRITICAL: Migrate selection cache from original artifact to new updated artifact
        // This ensures applyPartialUpdate can find the selection context when merging
        const originalSelection = artifactCache.getSelection(existingArtifact.id);
        if (originalSelection) {
          console.log('🔄 Migrating selection cache from original to updated artifact:', {
            from: existingArtifact.id,
            to: updatedIdentifier,
            selection: originalSelection,
            oldText: originalSelection.originalText,
            newText: finalContent,
          });

          // Copy the selection context to the new updated artifact
          // IMPORTANT: Update the originalText to the NEW content from the LLM
          artifactCache.setSelection(updatedIdentifier, {
            ...originalSelection,
            updatedText: finalContent, // Store the updated text
            artifactId: updatedIdentifier,
            artifactMessageId: messageId,
          });

          // Also cache the content for the updated artifact
          artifactCache.setContent(updatedIdentifier, finalContent, {
            title: updatedTitle,
            type: type,
            identifier: updatedIdentifier,
            source: 'directive',
          });

          console.log('✅ Selection cache migrated with NEW content:', {
            originalTextPreview: originalSelection.originalText.substring(0, 50),
            newTextPreview: finalContent.substring(0, 50),
            cachedForArtifact: updatedIdentifier,
          });
        } else {
          console.log('⚠️ No selection cache found for original artifact:', existingArtifact.id);
          const allSelectionEntries = Array.from(artifactCache._selectionCache.entries());
          const selectionEntryValue = allSelectionEntries.find(
            ([_, details]) => details.fileKey === existingArtifact.id,
          );

          if (selectionEntryValue) {
            const selectionEntry = selectionEntryValue[1];
            console.log('cachedSelection from parent/original artifact', selectionEntry);
            artifactCache.setSelection(updatedIdentifier, {
              ...selectionEntry,
              updatedText: finalContent, // Store the updated text
              artifactId: updatedIdentifier,
              artifactMessageId: messageId,
            });
            artifactCache.setContent(updatedIdentifier, finalContent, {
              title: updatedTitle,
              type: type,
              identifier: updatedIdentifier,
              source: 'directive',
            });
          }
        }

        setArtifacts((prevArtifacts) => {
          // CHANGED: Do NOT update the base artifact during streaming
          // Keep base artifact unchanged, only save the update artifact
          // On refresh, ArtifactTabs will reconstruct by applying all updates

          console.log('💾 [Artifact] Saving update artifact (base unchanged):', {
            baseId: existingArtifact.id,
            updateId: updatedIdentifier,
            updateContentLength: finalContent?.length,
          });

          return {
            ...prevArtifacts,
            // Base artifact stays UNCHANGED
            [existingArtifact.id]: existingArtifact,
            // Save the new update artifact
            [updatedIdentifier]: updatedArtifact,
          };
        });

        setVisibleArtifacts((prevVisible) => ({
          ...prevVisible,
          [existingArtifact.id]: existingArtifact,
          [updatedIdentifier]: updatedArtifact,
        }));

        setArtifact(updatedArtifact);

        // Auto-select the updated artifact so it displays immediately
        setCurrentArtifactId(updatedIdentifier);
        console.log('✅ Auto-selected updated artifact:', updatedIdentifier);

        // Also persist the updated artifact to the message text for refresh persistence

        setTimeout(() => {
          setRefreshTrigger((prev) => prev + 1);
        }, 100);
        return;
      } else {
        console.log('⚠️ No existing artifact found for identifier:', identifier);
      }
    }
    console.log('🔍 Proceeding with regular artifact creation for identifier:', identifier);
    const artifactKey = `${identifier}_${type}_${title}_${messageId}`
      .replace(/\s+/g, '_')
      .toLowerCase();

    throttledUpdateRef.current(() => {
      const now = Date.now();
      if (artifactKey === `${defaultIdentifier}_${defaultType}_${defaultTitle}_${messageId}`) {
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
        isUpdate: false, // Regular artifact creation - not an update
      };

      if (!location.pathname.includes('/c/')) {
        setArtifact(currentArtifact);
        setCurrentArtifactId(currentArtifact.id);
        return;
      }

      setArtifacts((prevArtifacts) => {
        if (
          prevArtifacts?.[artifactKey] != null &&
          prevArtifacts[artifactKey]?.content === content
        ) {
          return prevArtifacts;
        }

        return {
          ...prevArtifacts,
          [artifactKey]: currentArtifact,
        };
      });

      setArtifact(currentArtifact);
      setCurrentArtifactId(currentArtifact.id);
    });
  }, [
    artifact,
    props.children,
    props.title,
    props.type,
    props.identifier,
    message,
    isArtifactUpdateNode,
    messageId,
    _artifacts,
    getFirstArtifactInChain,
    setArtifacts,
    setVisibleArtifacts,
    setCurrentArtifactId,
    setRefreshTrigger,
    location.pathname,
  ]);

  // Add this ref at the top-level of the component, not inside useEffect
  const lastProcessedMessageId = useRef<string | null>(null);

  // --- NEW: Update local artifact state when selected artifact changes ---
  useEffect(() => {
    console.log('[Artifact] Detected _currentArtifactId change:', _currentArtifactId, _artifacts);
    if (_currentArtifactId && _artifacts && _artifacts[_currentArtifactId]) {
      const loadedArtifact = _artifacts[_currentArtifactId];

      console.log('🔍 [Cache Reconstruction] Loaded artifact:', {
        id: loadedArtifact.id,
        identifier: loadedArtifact.identifier,
        isUpdate: loadedArtifact.isUpdate,
        contentPreview: loadedArtifact.content?.substring(0, 100),
      });

      // If this is an updated artifact and the cache is missing, DON'T reconstruct
      // Instead, just use the artifact content as-is (it should already be fully merged from the backend)
      const isUpdate = loadedArtifact.isUpdate;
      const hasCache = artifactCache.getContent(_currentArtifactId);

      console.log('🔍 [Cache Reconstruction] Cache status:', {
        isUpdate,
        hasCache: !!hasCache,
        shouldReconstruct: isUpdate && !hasCache,
      });

      // CRITICAL FIX: Don't reconstruct on refresh - the artifact content is already complete
      // Only reconstruct if the content looks incomplete or corrupted
      if (isUpdate && !hasCache && loadedArtifact.content) {
        const looksCorrupted =
          loadedArtifact.content.includes('<header>') &&
          loadedArtifact.content.includes('body {') &&
          loadedArtifact.content.indexOf('<header>') < loadedArtifact.content.indexOf('</style>');

        console.log('🔍 [Cache Reconstruction] Content corruption check:', {
          looksCorrupted,
          hasHeaderTag: loadedArtifact.content.includes('<header>'),
          hasBodyCSS: loadedArtifact.content.includes('body {'),
        });

        if (looksCorrupted) {
          console.warn(
            '⚠️ [Cache Reconstruction] Corrupted content detected, skipping reconstruction',
          );
          // Don't reconstruct - just use as-is and log the issue
        }
      }

      setArtifact(loadedArtifact);
    }
  }, [_currentArtifactId, _artifacts]);

  useEffect(() => {
    // Compose a unique key for the artifact update
    const updateKey = `${props.identifier}_${props.type}_${props.title}_${messageId}`;
    let content = extractContent(props.children);
    const extracted = extractNodes(props.children);
    console.log('console and extracted', content, extracted);
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

    // For artifact updates, always process if content has changed (even if empty initially)
    // This allows continuous merging as content streams in
    if (
      shouldProcess &&
      (lastUpdateKey.current !== updateKey ||
        lastContent.current !== content ||
        lastProcessedMessageId.current !== messageId)
    ) {
      lastUpdateKey.current = updateKey;
      lastContent.current = content;
      lastProcessedMessageId.current = messageId;
      resetCounter();
      updateArtifact();
    } else if (!_currentArtifactId && hasContent) {
      // If no artifact is selected (e.g. on refresh), select this one (but only if it has content)
      setCurrentArtifactId(artifact?.id ?? null);
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
    artifact?.id,
    isArtifactUpdateNode,
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

  console.log('Rendering Artifact component with displayArtifact:', artifact, displayArtifact);
  return <ArtifactButton artifact={artifact} />;
}

// Export the main Artifact component as ArtifactUpdate for backward compatibility
// Both artifact and artifactupdate directives now use the same component
export const ArtifactUpdate = Artifact;
