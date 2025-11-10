import { useRef, useEffect, useState, useCallback } from 'react';
import React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { CodeEditorRef } from '@codesandbox/sandpack-react';
import type { Artifact } from '~/common';
import { useCodeState } from '~/Providers/EditorContext';
import { useArtifactsContext, useChatContext } from '~/Providers';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useAutoScroll } from '~/hooks/Artifacts/useAutoScroll';
import { ArtifactCodeEditor } from './ArtifactCodeEditor';
import { useGetStartupConfig } from '~/data-provider';
import { ArtifactPreview } from './ArtifactPreview';
import { useRecoilState } from 'recoil';
import { useSubmitMessage } from '~/hooks';
import { artifactsState } from '~/store/artifacts';
import { artifactCache } from './ArtifactCache';
import {
  applyAllPartialUpdates,
  applyPartialUpdate,
  ensureArtifactCacheHydrated,
} from '~/hooks/Artifacts/useArtifactUtlis';

export default function ArtifactTabs({
  artifact,
  editorRef,
  previewRef,
  isSharedConvo,
}: {
  artifact: Artifact;
  editorRef: React.MutableRefObject<CodeEditorRef>;
  previewRef: React.MutableRefObject<SandpackPreviewRef>;
  isSharedConvo?: boolean;
}) {
  const { isSubmitting } = useArtifactsContext();
  const { currentCode, setCurrentCode } = useCodeState();
  const { data: startupConfig } = useGetStartupConfig();
  const { latestMessage: _latestMessage } = useChatContext();
  const [_artifacts, _setArtifacts] = useRecoilState(artifactsState);
  const [_cacheHydrated, _setCacheHydrated] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  const finalArtifact = artifact.isUpdate
    ? (_artifacts?.[artifact.id] ?? artifact) // Update artifacts: prefer state
    : artifact; // Base artifacts: always use prop (pristine original)

  // Check if message is streaming (compute early to use in useMemo)
  // A message is streaming ONLY if explicitly marked as unfinished
  const isMessageStreaming = _latestMessage?.unfinished === true;
  const lastIsSubmittingRef = useRef<boolean>(false);
  const [streamingCompleteTrigger, setStreamingCompleteTrigger] = useState(0);

  useEffect(() => {
    const wasStreaming = lastIsSubmittingRef.current;
    const isNowComplete = !isSubmitting;

    if (wasStreaming && isNowComplete) {
      console.log('✅ [ArtifactTabs] Streaming complete - triggering re-merge', {
        streamingCompleteTrigger,
      });
      // Force useMemo to recompute by incrementing trigger
      setStreamingCompleteTrigger((prev) => prev + 1);
    }

    lastIsSubmittingRef.current = isSubmitting;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting]);

  const lastComputedIdRef = useRef<string | null>(null);
  const lastMergedResultRef = useRef<Artifact | null>(null);

  const mergedArtifact = React.useMemo(() => {
    if (isMessageStreaming || isSubmitting) {
      // Return raw artifact content during streaming - no merge, no cache
      return finalArtifact;
    }

    if (!finalArtifact || !_artifacts) {
      console.log('⚠️ [mergedArtifact] No finalArtifact or _artifacts');
      return finalArtifact;
    }

    //if (!latestMessage?.content || !latestMessage.messageId) return;
    // If this is an update artifact, we need to merge all updates up to this point
    if (finalArtifact.isUpdate) {
      // Don't split it - just use it directly (splitting would break identifiers with underscores)
      const baseIdentifier = finalArtifact.identifier;
      const currentUpdateIndex =
        finalArtifact.index ?? parseInt(finalArtifact.id?.match(/_update(\d+)_/)?.[1] || '0', 10);

      // Get all artifacts with same identifier, sorted by index/time
      const relatedArtifacts = _artifacts
        ? Object.values(_artifacts)
            .filter((a) => a && a.identifier === baseIdentifier)
            .sort((a, b) => {
              const _indexA = a?.index ?? parseInt(a?.id?.match(/_update(\d+)_/)?.[1] || '-1', 10);
              const _indexB = b?.index ?? parseInt(b?.id?.match(/_update(\d+)_/)?.[1] || '-1', 10);
              return _indexB - _indexA; // Descending: newest first
            })
        : [];
      const previousArtifact = relatedArtifacts.find((a) => {
        //if (!a?.isUpdate) return true; // Base artifact is always a candidate
        const artifactIndex = a?.index ?? parseInt(a?.id?.match(/_update(\d+)_/)?.[1] || '0', 10);
        return artifactIndex < currentUpdateIndex;
      });

      // Fallback: if no previous update found, use base artifact
      const originalArtifact = previousArtifact || relatedArtifacts.find((a) => a && !a.isUpdate);
      // On refresh, artifact.content might be empty/partial, so we need to merge regardless
      if (originalArtifact && originalArtifact.content) {
        let baseContentForMerge = originalArtifact.content ?? '';
        if (previousArtifact?.isUpdate) {
          const cachedPrevious = artifactCache.getContent(previousArtifact.id);
          if (cachedPrevious && cachedPrevious.content && cachedPrevious.content.trim() !== '') {
            baseContentForMerge = cachedPrevious.content;
          } else {
            baseContentForMerge = previousArtifact.content ?? originalArtifact.content ?? '';
          }
        }

        // Now apply THIS update to the base content (which could be cached previous merged result)
        const mergedContent = applyPartialUpdate(
          baseContentForMerge, // ✅ Use cached previous merged result OR base
          finalArtifact.content ?? '', // New update snippet
          finalArtifact.id,
          Object.keys(_artifacts).length,
          _artifacts,
        );

        const result = {
          ...finalArtifact,
          content: mergedContent,
        };
        lastComputedIdRef.current = finalArtifact.id;
        lastMergedResultRef.current = result;
        // This ensures subsequent updates use the faster applyPartialUpdate instead of applyAllPartialUpdates
        if (isInitialLoad) {
          console.log('🔄 [ArtifactTabs] First merge complete - setting isInitialLoad to false');
          setIsInitialLoad(false);
        }

        return result;
      } else {
        console.warn('⚠️ [mergedArtifact] No base artifact found or base has no content!');
      }
    } else {
      console.log('ℹ️ [mergedArtifact] This is a BASE artifact, returning as-is');
    }
    return finalArtifact;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    finalArtifact?.id, // Only depend on ID, not entire object
    isMessageStreaming,
    _artifacts,
    isInitialLoad,
    streamingCompleteTrigger,
  ]);

  // Helper to check if content is a full document (not a snippet)
  // Works for all artifact formats (HTML, Python, React, SVG, Mermaid, etc.)
  const isFullDoc = (content: string) => {
    // Use multiple heuristics to detect full documents vs snippets
    const lines = content.split('\n').length;
    const length = content.length;

    // Full documents are typically:
    // 1. More than 10 lines OR
    // 2. More than 500 characters OR
    // 3. Contain typical full-document markers
    return (
      lines > 10 ||
      length > 500 ||
      /<!DOCTYPE|<html|<head>|<body>|^import\s+|^from\s+|^def\s+\w+\(|^class\s+\w+|^function\s+\w+\(/im.test(
        content,
      )
    );
  };

  // This prevents saving when just clicking tabs or viewing content
  const wasMergedRef = useRef(false);
  const lastSaveTimestampRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Track if we actually performed a merge in the useMemo above
    wasMergedRef.current =
      mergedArtifact?.id === lastComputedIdRef.current &&
      mergedArtifact?.isUpdate === true &&
      mergedArtifact?.content !== finalArtifact?.content;
  }, [mergedArtifact, finalArtifact]);

  useEffect(() => {
    if (!mergedArtifact || !mergedArtifact.content || !mergedArtifact.id) {
      return;
    }
    if (isMessageStreaming) {
      return;
    }

    if (!isFullDoc(mergedArtifact.content)) {
      return;
    }

    if (!wasMergedRef.current) {
      return;
    }
    if (!mergedArtifact.isUpdate) {
      return;
    }

    const cachedContent = artifactCache.getContent(mergedArtifact.id);
    if (cachedContent?.content === mergedArtifact.content) {
      return;
    }

    const lastSaveTime = lastSaveTimestampRef.current.get(mergedArtifact.id) || 0;
    const timeSinceLastSave = Date.now() - lastSaveTime;
    if (timeSinceLastSave < 2000) {
      return;
    }

    lastSaveTimestampRef.current.set(mergedArtifact.id, Date.now());
    artifactCache.setContent(mergedArtifact.id, mergedArtifact.content);
  }, [mergedArtifact, _artifacts, isMessageStreaming]);

  const lastIdRef = useRef<string | null>(null);
  const [cacheInitialized, setCacheInitialized] = useState(false);

  const initializeCache = useCallback(
    async (artifactId: string) => {
      if (artifactId && !cacheInitialized) {
        try {
          // Load artifact-specific cache from database
          await artifactCache.initWithDatabase(artifactId);
          await artifactCache._loadFromDatabase(artifactId);
          setCacheInitialized(true);
        } catch (error) {
          console.error('❌ [ArtifactTabs] Failed to initialize cache:', error);
          setCacheInitialized(true);
        }
      }
    },
    [cacheInitialized],
  );

  useEffect(() => {
    if (artifact.id !== lastIdRef.current) {
      setCurrentCode(undefined);
      initializeCache(artifact.id);
    }
    lastIdRef.current = artifact.id;
  }, [setCurrentCode, artifact.id, initializeCache]);

  useEffect(() => {
    async function hydrateCache() {
      if (artifact?.id) {
        await ensureArtifactCacheHydrated(artifact.id);
        // Now you can safely use artifactCache.getSelection, getContent, etc.
      }
    }
    hydrateCache();
  }, [artifact?.id]);
  // Reload preview when artifact content changes
  const [previewKey, setPreviewKey] = useState(0);
  const [_codeEditorKey, setCodeEditorKey] = useState(0);
  const lastPreviewIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (mergedArtifact && mergedArtifact.content) {
      setPreviewKey((prev) => prev + 1);
      setCodeEditorKey((prev) => prev + 1);
      lastPreviewIdRef.current = mergedArtifact.id;
      setCurrentCode(mergedArtifact.content);
    }
  }, [mergedArtifact, setCurrentCode]);
  const lastMergedIdRef = useRef<string | null>(null);

  // Update currentCode when artifact content changes DO NOT TOUCH OTHERWISE IT BREAKS UPDATES
  useEffect(() => {
    if (currentCode === undefined) {
      const updateArtifact = artifact;
      if (!updateArtifact.isUpdate) {
        setCurrentCode(updateArtifact.content);
        return;
      }
      const baseIdentifier = updateArtifact.identifier;
      let originalArtifact: typeof artifact | undefined = undefined;
      if (baseIdentifier && _artifacts && typeof _artifacts === 'object') {
        originalArtifact = Object.values(_artifacts).find(
          (a) => a && a.identifier === baseIdentifier && !a.isUpdate,
        );
      }
      if (originalArtifact && originalArtifact.content) {
        const mergedContent = applyAllPartialUpdates(
          originalArtifact.content,
          _artifacts,
          artifact.id,
          false, 
          null,
        );
        setCurrentCode(mergedContent);
      } else {
        setCurrentCode(artifact.content);
      }
    }
  }, [mergedArtifact, currentCode, setCurrentCode, artifact, _artifacts]);

  useEffect(() => {
    // Only update if the artifact actually changed (not just currentCode)
    if (mergedArtifact?.id && mergedArtifact.id !== lastMergedIdRef.current) {
      if (mergedArtifact.content) {
      setCurrentCode(mergedArtifact.content);
    }
      lastMergedIdRef.current = mergedArtifact.id;
    }
  }, [mergedArtifact, setCurrentCode, currentCode]);

  const { submitMessage } = useSubmitMessage();
  const displayArtifact = isMessageStreaming
    ? artifact
    : artifactCache.getDisplayArtifact(artifact.id, _artifacts || undefined) || artifact;

  let content: string;

  if (artifact.isUpdate) {
    // User clicked on an UPDATE artifact button - show CUMULATIVE merged content (base + all updates up to this point)
    // Find the base artifact first
    const baseArtifact = _artifacts
      ? Object.values(_artifacts).find(
          (a) => a && !a.isUpdate && a.identifier === artifact.identifier,
        )
      : null;

    if (baseArtifact && _artifacts) {
      // Use applyAllPartialUpdates to compute progressive merge up to this artifact
      const cumulativeMergedContent = applyAllPartialUpdates(
        baseArtifact.content || '',
        _artifacts,
        artifact.id, // Target artifact ID - this will merge all updates up to and including this one
        false, // Not streaming
        null,
      );
      content = cumulativeMergedContent || '';
    } else {
      // Fallback if base artifact not found
      content = displayArtifact?.content ?? artifact.content ?? '';
    }
  } else {
    content = artifact.content ?? '';
  }
  const props = useArtifactProps({ artifact: displayArtifact });
  const files = { ...props.files };
  const fileKey = props.fileKey;
  const template = props.template;
  const sharedProps = props.sharedProps;

  // Override the main file's content with the merged content for the code editor
  if (files && fileKey && content) {
    files[fileKey] = content;
  }
  const contentRef = useRef<HTMLDivElement>(null);
  useAutoScroll({ ref: contentRef, content, isSubmitting });

  // Helper function to get language from artifact type
  const getLanguageFromType = (type?: string): string => {
    if (type === 'code/javascript') return 'javascript';
    if (type === 'text/html') return 'html';
    return 'text';
  };

  // Handle selection submissions from the CodeEditor component
  const handleSelectionSubmit = useCallback(
    (messageData: any) => {
      const systemInstructions = `You are helping edit code in an artifact. 
When providing your updated code, use the artifactupdate directive format:

:::artifactupdate{identifier="${artifact.identifier}" type="${artifact.type || 'text/html'}" title="${artifact.title || 'Updated Artifact'}"}
\`\`\`${getLanguageFromType(artifact.type)}
[your updated code here]
\`\`\`
:::

CRITICAL RULES (follow in this order):
1. IDENTIFIER: Use ${artifact.identifier || artifact.id} exactly as-is
2. SCOPE: Return ONLY the code section being changed, NEVER the full artifact OR ANY OTHER CODE. It is replacing the existing content in the artifact. ** NO EXTRA CODE!**
3. CONTEXT: Read entire previous artifact to understand change location, then output only updates
4. NO EXPLANATIONS: Zero preamble text before ::artifactupdate marker
5. PRESERVE FORMATTING: Match original spacing, indentation, line breaks exactly
6. NO DUPLICATION: Only include code being modified; never repeat existing unchanged code
7. INSERTION READY: Format output so it's directly replaceable at the specified location
8. ASSUME YES: Make decisions without asking user confirmation
9. VALIDATION: Ensure updates align logically with user request and artifact type
`;

      submitMessage({
        text: messageData.message,
        artifactInfo: {
          artifactId: artifact.id,
          artifactType: artifact.type ?? '',
        },
        systemInstructions,
      });
    },
    [artifact, submitMessage],
  );

  // --- Auto-select preview tab when artifact changes ---
  const [_tabValue, setTabValue] = useState('preview');
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (!hasInitialized.current && artifact.id) {
      setTabValue('preview');
      hasInitialized.current = true;
    }
  }, [artifact.id]);

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs.Content
        ref={contentRef}
        value="code"
        id="artifacts-code"
        className="h-full w-full flex-grow overflow-auto"
        tabIndex={-1}
      >
        <ArtifactCodeEditor
          files={files}
          fileKey={fileKey}
          template={template}
          artifact={displayArtifact}
          editorRef={editorRef}
          sharedProps={sharedProps}
          readOnly={isSharedConvo}
          onSelectionSubmit={handleSelectionSubmit}
        />
      </Tabs.Content>

      <Tabs.Content value="preview" className="h-full w-full flex-grow overflow-auto" tabIndex={-1}>
        <ArtifactPreview
          files={files}
          fileKey={fileKey}
          template={template}
          previewRef={previewRef}
          sharedProps={sharedProps}
          currentCode={currentCode}
          startupConfig={startupConfig}
          isMermaid={isMermaid}
        />
      </Tabs.Content>
    </div>
  );
}
