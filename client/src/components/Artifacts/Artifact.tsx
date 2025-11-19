import React, { useEffect, useCallback, useRef, useState } from 'react';
import throttle from 'lodash/throttle';
import { visit } from 'unist-util-visit';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext } from '~/Providers';
import { logger, extractContent, isArtifactRoute } from '~/utils';
import { artifactsState } from '~/store/artifacts';
import { extractNodes, extractContent } from '~/utils';
import ArtifactButton from './ArtifactButton';
import { artifactCache } from './ArtifactCache';
import store from '~/store';
import { applyPartialUpdate } from '~/hooks/Artifacts/useArtifactUtlis';
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
  const [_visibleArtifacts, _setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const [_currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const lastUpdateKey = useRef<string | null>(null);
  const lastContent = useRef<string | null>(null);
  const [_refreshTrigger, _setRefreshTrigger] = useRecoilState(artifactRefreshTriggerState);
  let displayArtifact;

  const throttledUpdateRef = useRef(
    throttle((updateFn: () => void) => {
      updateFn();
    }, 25),
  );

  // Helper function to check if message streaming is complete
  function isFullyLoadedMessage(msg: any) {
    if (!msg) return false;

    // Check if message has finish reason or unfinished flag
    if (msg.finish_reason === 'stop' || msg.finish_reason === 'length') {
      return true;
    }
    if (msg.unfinished === false) {
      return true;
    }

    // Check for artifact closing tags (reliable indicator of completion)
    if (typeof msg.text === 'string') {
      // Look for closing artifact tags
      if (msg.text.includes(':::') && msg.text.lastIndexOf(':::') > msg.text.indexOf(':::')) {
        return true; // Has both opening and closing :::
      }
    }

    // For content-based checking
    if (typeof msg.content === 'string') {
      if (
        msg.content.includes(':::') &&
        msg.content.lastIndexOf(':::') > msg.content.indexOf(':::')
      ) {
        return true;
      }
    }

    if (Array.isArray(msg.content)) {
      const hasClosingTag = msg.content.some((item: any) => {
        if (typeof item.text === 'string') {
          return (
            item.text.includes(':::') && item.text.lastIndexOf(':::') > item.text.indexOf(':::')
          );
        }
        return false;
      });
      if (hasClosingTag) return true;
    }

    // Default to true if we can't determine (prevents blocking artifacts)
    return true;
  }

  const fullyLoaded = isFullyLoadedMessage(message);

  const _getFirstArtifactInChain = useCallback(
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

    console.log('shouldUpdate', shouldUpdate);
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
        // CRITICAL: For chaining updates, use the MOST RECENT artifact (not the original base)
        // This allows updates to build on previous updates
        // Find all artifacts with this identifier
        const allRelatedArtifacts = Object.values(_artifacts || {}).filter(
          (a) =>
            a &&
            typeof a.identifier === 'string' &&
            (a.identifier === identifier || a.identifier.startsWith(identifier)),
        );

        // Sort by lastUpdateTime descending (newest first)
        allRelatedArtifacts.sort((a, b) => {
          const timeA = a?.lastUpdateTime || 0;
          const timeB = b?.lastUpdateTime || 0;
          return timeB - timeA; // Descending - newest first
        });

        // Use the most recent artifact as the base for this update
        const mostRecentArtifact = allRelatedArtifacts[0] || existingArtifact;
        const baseContent = mostRecentArtifact.content || '';

        console.log('🔍 Using most recent artifact as base:', {
          baseId: mostRecentArtifact.id,
          baseIdentifier: mostRecentArtifact.identifier,
          isUpdate: mostRecentArtifact.isUpdate,
          baseContentLength: baseContent.length,
        });

        // Apply the partial update using cached selection context
        console.log('🔍 Calling applyPartialUpdate with:', {
          baseContentLength: baseContent.length,
          newContentLength: content.length,
          artifactId: existingArtifact.id, // Use original artifact ID for cache lookup
          updateIndex: 0,
        });

        // Apply the partial update to the MOST RECENT content (not original base)
        finalContent = applyPartialUpdate(
          baseContent, // Content from most recent artifact
          content, // NEW content from LLM
          existingArtifact.id, // Original artifact ID for cache lookup
          0,
          _artifacts || undefined,
        );

        console.log('🔍 After applyPartialUpdate, finalContent length:', finalContent.length);
        console.log('🔍 finalContent preview:', finalContent.substring(0, 200));

        // Create a new update artifact with incremented index
        const relatedUpdates = Object.values(_artifacts || {}).filter(
          (a) =>
            a &&
            a.identifier === existingArtifact.identifier &&
            a.messageId === messageId &&
            a.isUpdate,
        );
        const newUpdateIndex = relatedUpdates.length;

        const updateArtifactKey =
          `${existingArtifact.identifier}_update${newUpdateIndex}_${type}_${title}_${messageId}`
            .replace(/\s+/g, '_')
            .toLowerCase();

        console.log('🔍 Creating new update artifact with key:', updateArtifactKey);

        const updateArtifact: Artifact = {
          id: updateArtifactKey,
          identifier: existingArtifact.identifier,
          title: existingArtifact.title,
          type: existingArtifact.type,
          content: finalContent, // Store the merged content
          messageId,
          index: newUpdateIndex,
          lastUpdateTime: Date.now(),
          isUpdate: true, // Mark as an update artifact
        };

        console.log('🔍 Update artifact created:', {
          id: updateArtifact.id,
          identifier: updateArtifact.identifier,
          isUpdate: updateArtifact.isUpdate,
          contentLength: updateArtifact.content?.length || 0,
          contentPreview: updateArtifact.content?.substring(0, 100) || '',
        });

        // Set the update artifact in the state
        throttledUpdateRef.current(() => {
          console.log('🔍 Setting artifacts state with new update artifact');
          setArtifacts((prevArtifacts) => {
            const updated = {
              ...prevArtifacts,
              [updateArtifactKey]: updateArtifact,
            };
            console.log('🔍 Updated artifacts state:', Object.keys(updated));
            return updated;
          });

          setArtifact(updateArtifact);
          setCurrentArtifactId(updateArtifact.id);

          // CRITICAL: Auto-open artifacts panel when update is applied
          setArtifactsVisible(true);

          console.log('✅ [Artifact] Setting local artifact state for update:', {
            artifactId: updateArtifact.id,
            identifier: updateArtifact.identifier,
            isUpdate: updateArtifact.isUpdate,
          });
        });
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
          (prevArtifacts[artifactKey]?.content?.length || 0) > content.length
        ) {
          console.log(
            '⚠️ Skipping artifact update - cached artifact is longer and still streaming',
          );
          return prevArtifacts; // Don't update if cached is longer
        }
        const updated = {
          ...prevArtifacts,
          [artifactKey]: currentArtifact,
        };
        return updated;
      });
      setArtifact(currentArtifact);
      setCurrentArtifactId(currentArtifact.id);

      // CRITICAL: Auto-open artifacts panel when new artifact is created
      setArtifactsVisible(true);

      console.log('✅ [Artifact] Setting local artifact state for regular creation:', {
        artifactId: currentArtifact.id,
        identifier: currentArtifact.identifier,
        title: currentArtifact.title,
      });
    });
  }, [
    artifact,
    message,
    props.children,
    props.title,
    props.type,
    props.identifier,
    isArtifactUpdateNode,
    messageId,
    _artifacts,
    setArtifacts,
    setCurrentArtifactId,
    location.pathname,
    setArtifactsVisible,
    fullyLoaded,
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

    // CRITICAL: For artifact updates, trigger on any content change
    // But use throttling inside updateArtifact to prevent excessive processing
    const shouldUpdate =
      shouldProcess &&
      (isArtifactUpdateNode
        ? lastContent.current !== content // For updates: trigger on ANY content change (throttled in updateArtifact)
        : lastUpdateKey.current !== updateKey || // For regular: trigger on key/content/message change
          lastContent.current !== content ||
          lastProcessedMessageId.current !== messageId);

    if (shouldUpdate) {
      lastUpdateKey.current = updateKey;
      lastContent.current = content;
      lastProcessedMessageId.current = messageId;
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
