import { useRef, useEffect, useState, useCallback } from 'react';
import React from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { SandpackPreviewRef, CodeEditorRef } from '@codesandbox/sandpack-react';
import type { Artifact } from '~/common';
import { useEditorContext, useArtifactsContext } from '~/Providers';
import { useChatContext } from '~/Providers';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useAutoScroll } from '~/hooks/Artifacts/useAutoScroll';
import { ArtifactCodeEditor } from './ArtifactCodeEditor';
import { useGetStartupConfig } from '~/data-provider';
import { ArtifactPreview } from './ArtifactPreview';
import { cn } from '~/utils';
import { useRecoilState } from 'recoil';
import { useSubmitMessage } from '~/hooks';
import { artifactsState } from '~/store/artifacts';
import { artifactCache } from './ArtifactCache';
import {
  applyAllPartialUpdates,
  ensureArtifactCacheHydrated,
} from '~/hooks/Artifacts/useArtifactUtlis';

export default function ArtifactTabs({
  artifact,
  isMermaid,
  editorRef,
  previewRef,
}: {
  artifact: Artifact;
  isMermaid: boolean;
  editorRef: React.MutableRefObject<CodeEditorRef>;
  previewRef: React.MutableRefObject<SandpackPreviewRef>;
}) {
  const { isSubmitting } = useArtifactsContext();
  const { currentCode, setCurrentCode } = useEditorContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { latestMessage: _latestMessage } = useChatContext();
  const [_artifacts, _setArtifacts] = useRecoilState(artifactsState);
  // const [artifact, setArtifact] = useState<Artifact | null>(null);

  // Cache state - must be before useMemo that uses it
  // const lastIdRef = useRef<string | null>(null);
  // const [_cacheInitialized, setCacheInitialized] = useState(false);
  const [_cacheHydrated, _setCacheHydrated] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true); // Track if this is initial load/refresh

  // Get the artifact from state, or use the passed prop
  const stateArtifact = _artifacts?.[artifact.id] ?? artifact;

  // Check if message is streaming (compute early to use in useMemo)
  // A message is streaming ONLY if explicitly marked as unfinished
  const isMessageStreaming = _latestMessage?.unfinished === true;

  // CRITICAL: Track streaming state to force re-merge when streaming completes
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

  // IMPORTANT: On refresh, reconstruct artifact by applying all updates to the base
  // CRITICAL: Don't recompute during streaming to prevent shaking
  const lastComputedIdRef = useRef<string | null>(null);
  const lastMergedResultRef = useRef<Artifact | null>(null);
  
  const mergedArtifact = React.useMemo(() => {
    console.log('🔍 [mergedArtifact useMemo] Entry:', {
      stateArtifactId: stateArtifact?.id,
      stateArtifactIsUpdate: stateArtifact?.isUpdate,
      stateArtifactIdentifier: stateArtifact?.identifier,
      stateArtifactContentLength: stateArtifact?.content?.length,
      lastComputedId: lastComputedIdRef.current,
      hasLastMergedResult: !!lastMergedResultRef.current,
      isMessageStreaming,
      streamingCompleteTrigger, // Used to force re-merge when streaming completes
    });

    if (stateArtifact?.id === lastComputedIdRef.current && lastMergedResultRef.current) {
      console.log('✅ [mergedArtifact] Returning cached result for:', stateArtifact?.id);
      return lastMergedResultRef.current;
    }

    if (!stateArtifact || !_artifacts) {
      console.log('⚠️ [mergedArtifact] No stateArtifact or _artifacts');
      return stateArtifact;
    }

    //if (!latestMessage?.content || !latestMessage.messageId) return;
    // If this is an update artifact, we need to merge all updates up to this point
    if (stateArtifact.isUpdate) {
      console.log('🔄 [mergedArtifact] This is an UPDATE artifact, need to merge');
      // CRITICAL: Update artifacts already have the SAME identifier as their base
      // Don't split it - just use it directly (splitting would break identifiers with underscores)
      const baseIdentifier = stateArtifact.identifier;

      // Find the original (base) artifact by matching the base identifier
      const originalArtifact = _artifacts
        ? Object.values(_artifacts).find((a) => a && a.identifier === baseIdentifier && !a.isUpdate)
        : undefined;
      console.log('🔍 [mergedArtifact] Base artifact search:', {
        baseIdentifier,
        originalArtifactFound: !!originalArtifact,
        originalArtifactId: originalArtifact?.id,
        originalArtifactContentLength: originalArtifact?.content?.length,
        allArtifactsCount: Object.keys(_artifacts).length,
        allArtifactIds: Object.keys(_artifacts),
      });

      // CRITICAL: ALWAYS merge if we have a base artifact, don't check if content differs
      // On refresh, artifact.content might be empty/partial, so we need to merge regardless
      if (originalArtifact && originalArtifact.content) {
        // Merge all updates up to and including this artifact
        // console.log('🟢🟢🟢 [CALL SITE 2: ArtifactTabs.tsx Line ~120] CALLING merge function:', {
        //   location: 'ArtifactTabs.tsx line ~120 - Tab Display',
        //   reason: 'Displaying merged content in tab',
        //   baseArtifactId: originalArtifact.id,
        //   targetArtifactId: stateArtifact.id,
        //   baseContentLength: originalArtifact.content.length,
        // allArtifactsCount: _artifacts ? Object.keys(_artifacts).length : 0,
        //   isStreaming: isInitialLoad || !!isMessageStreaming,
        //   isInitialLoad,
        //   conversationId: null,
        //   willUseApplyAll: isInitialLoad,
        //   willUseApplyPartial: !isInitialLoad,
        //   STACK_TRACE: new Error().stack?.split('\n').slice(1, 5).join('\n'),
        // });

        const mergedContent = !isMessageStreaming
          ? applyAllPartialUpdates(
          originalArtifact.content ?? '',
          _artifacts,
          stateArtifact.id,
              false, // Not streaming during initial load
              null, // conversationId not needed for display-only tabs
            )
          : (stateArtifact.content ?? originalArtifact.content ?? '');
        // } else {
        //   console.log('⚡ [Update Mode] Using applyPartialUpdate for single update');
        //   mergedContent = applyPartialUpdate(
        //     originalArtifact.content ?? '',
        //     stateArtifact.content ?? '',
        //     stateArtifact.id,
        //     Object.keys(_artifacts).length,
        //     _artifacts,
        //   );
        // }

        console.log('✅ [mergedArtifact] applyAllPartialUpdates returned:', {
          mergedContentLength: mergedContent?.length,
          mergedContentPreview: mergedContent?.substring(0, 200),
          isEmptyOrOriginal: mergedContent === originalArtifact.content,
        });

        const result = {
          ...stateArtifact,
          content: mergedContent,
        };
        lastComputedIdRef.current = stateArtifact.id;
        lastMergedResultRef.current = result;

        // CRITICAL: Set isInitialLoad to false after first successful merge
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

    // If it's not an update or we couldn't find the base, return as-is
    console.log('⏭️ [mergedArtifact] Returning stateArtifact as-is');
    return stateArtifact;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stateArtifact?.id, // Only depend on ID, not entire object
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

  const wasMergedRef = useRef(false);
  const lastSaveTimestampRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Track if we actually performed a merge in the useMemo above
    wasMergedRef.current =
      mergedArtifact?.id === lastComputedIdRef.current &&
      mergedArtifact?.isUpdate === true &&
      mergedArtifact?.content !== stateArtifact?.content;
  }, [mergedArtifact, stateArtifact]);

  useEffect(() => {
    if (!mergedArtifact || !mergedArtifact.content || !mergedArtifact.id) {
      return;
    }

    // Guard 1: Don't save during streaming (Artifact.tsx handles that)
    if (isMessageStreaming) {
      console.log('⏭️ [ArtifactTabs] Skipping cache save during streaming');
      return;
    }

    // Guard 2: Only save FULL DOCUMENTS (not snippets)
    if (!isFullDoc(mergedArtifact.content)) {
      //console.log('⏭️ [ArtifactTabs] Skipping cache save for snippet content');
      return;
    }

    // Guard 3: Only save if we actually performed a merge (not just viewing)
    if (!wasMergedRef.current) {
      //console.log('⏭️ [ArtifactTabs] Skipping cache save - no merge was performed');
      return;
    }

    // Guard 3.5: NEVER save to BASE artifacts - only UPDATE artifacts should be saved
    // Base artifacts should preserve their original content
    if (!mergedArtifact.isUpdate) {
      // /console.log('⏭️ [ArtifactTabs] Skipping cache save - BASE artifacts should not be modified', {
      //   artifactId: mergedArtifact.id,
      //   isUpdate: mergedArtifact.isUpdate,
      // });
      return;
    }

    // Guard 4: Only save if content is different from cached
    const cachedContent = artifactCache.getContent(mergedArtifact.id);
    if (cachedContent?.content === mergedArtifact.content) {
      //console.log('⏭️ [ArtifactTabs] Skipping cache save - content already cached');
      return; // Already cached, no need to save
    }

    // Guard 5: Prevent duplicate saves within 2 seconds (debounce)
    const lastSaveTime = lastSaveTimestampRef.current.get(mergedArtifact.id) || 0;
    const timeSinceLastSave = Date.now() - lastSaveTime;
    if (timeSinceLastSave < 2000) {
      //console.log('⏭️ [ArtifactTabs] Skipping cache save - saved recently:', {
      //  artifactId: mergedArtifact.id,
      //  timeSinceLastSave,
      //});
      return;
    }

    // console.log('💾 [ArtifactTabs] Saving merged content to cache:', {
    //   artifactId: mergedArtifact.id,
    //   isUpdate: mergedArtifact.isUpdate,
    //   contentLength: mergedArtifact.content.length,
    //   isStreaming: isMessageStreaming,
    // });

    // Update timestamp tracker
    lastSaveTimestampRef.current.set(mergedArtifact.id, Date.now());

    artifactCache.setContent(mergedArtifact.id, mergedArtifact.content);

    // console.log('✅ [ArtifactTabs] Saved merged content to UPDATE artifact only:', {
    //   updateArtifactId: mergedArtifact.id,
    //   preservedBaseArtifact: true,
    // });
  }, [mergedArtifact, _artifacts, isMessageStreaming]);

  const lastIdRef = useRef<string | null>(null);
  const [cacheInitialized, setCacheInitialized] = useState(false);

  const initializeCache = useCallback(
    async (artifactId: string) => {
      if (artifactId && !cacheInitialized) {
        console.log('🔄 [ArtifactTabs] Initializing cache for artifact:', artifactId);

        try {
          // Load artifact-specific cache from database
          await artifactCache.initWithDatabase(artifactId);
          await artifactCache._loadFromDatabase(artifactId);
          setCacheInitialized(true);

          console.log('✅ [ArtifactTabs] Cache initialized successfully for:', artifactId);
        } catch (error) {
          console.error('❌ [ArtifactTabs] Failed to initialize cache:', error);
          setCacheInitialized(true); // Still mark as initialized to prevent retries
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
    console.log('artifact.id', artifact.id, 'lastIdRef.current', lastIdRef.current);
    lastIdRef.current = artifact.id;
  }, [setCurrentCode, artifact.id, initializeCache]);

  useEffect(() => {
    async function hydrateCache() {
      console.log('hydrate cache called', artifact?.id);
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
      const updateArtifact = artifact; // could be an update

      // CRITICAL FIX: Only process UPDATE artifacts through merge logic
      // Base artifacts should use their content directly without merge processing
      if (!updateArtifact.isUpdate) {
        console.log('ℹ️ [ArtifactTabs] Base artifact - using content directly without merge');
        setCurrentCode(updateArtifact.content);
        return;
      }

      // Only continue with merge logic for UPDATE artifacts
      // CRITICAL: Update artifacts already have the SAME identifier as their base
      // Don't split it - just use it directly (splitting would break identifiers with underscores)
      const baseIdentifier = updateArtifact.identifier;
      let originalArtifact: typeof artifact | undefined = undefined;
      if (baseIdentifier && _artifacts && typeof _artifacts === 'object') {
        originalArtifact = Object.values(_artifacts).find(
          (a) => a && a.identifier === baseIdentifier && !a.isUpdate,
        );
      }
      console.log('[ArtifactTabs] useEffect: artifact.content:', artifact.content);
      console.log('[ArtifactTabs] useEffect: currentCode:', currentCode);
      console.log('[ArtifactTabs] useEffect: baseIdentifier:', baseIdentifier);
      console.log('[ArtifactTabs] useEffect: originalArtifact:', originalArtifact);
      if (originalArtifact && originalArtifact.content) {
        // console.log(
        //   '🟡🟡🟡 [CALL SITE 3: ArtifactTabs.tsx Line ~315] CALLING applyAllPartialUpdates:',
        //   {
        //     location: 'ArtifactTabs.tsx line ~315 - Update Artifact Display',
        //     reason: 'Displaying update artifact with merged content',
        //     baseArtifactId: originalArtifact.id,
        //     targetArtifactId: artifact.id,
        //     baseContentLength: originalArtifact.content.length,
        //     allArtifactsCount: _artifacts ? Object.keys(_artifacts).length : 0,
        //     isStreaming: false,
        //     conversationId: null,
        //     STACK_TRACE: new Error().stack?.split('\n').slice(1, 5).join('\n'),
        //   },
        // );

        const mergedContent = applyAllPartialUpdates(
          originalArtifact.content,
          _artifacts,
          artifact.id,
          false, // not streaming
          null, // conversationId not needed for display-only tabs
        );
        console.log('mergedContent in useEffect', mergedContent);
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
  
  // CRITICAL: Only call getDisplayArtifact when NOT streaming
  // During streaming, use the artifact as-is to prevent rendering incomplete/duplicate content
  const displayArtifact = isMessageStreaming
    ? artifact
    : artifactCache.getDisplayArtifact(artifact.id, _artifacts || undefined) || artifact;

  // CRITICAL: On page refresh, displayArtifact has the freshly computed merged content
  // from getDisplayArtifact(), which should take priority over stale mergedArtifact
  // Use displayArtifact if it has isMerged=true (indicating fresh merge from getDisplayArtifact)
  const content =
    displayArtifact?.isMerged && displayArtifact?.content
      ? displayArtifact.content
      : (mergedArtifact?.content ?? displayArtifact?.content ?? '');

  const props = useArtifactProps({ artifact: displayArtifact });
  const files = { ...props.files };
  const fileKey = props.fileKey;
  const template = props.template;
  const sharedProps = props.sharedProps;

  // Override the main file's content with the merged content for the code editor
  if (files && fileKey && content) {
    files[fileKey] = content;
    console.log('📝 [ArtifactTabs] Set files[fileKey] to content:', {
      fileKey,
      contentLength: content.length,
      contentPreview: content.substring(0, 150),
    });
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
      const systemInstructions = `⚠️ CRITICAL ARTIFACT UPDATE MODE ⚠️

You MUST return ONLY the selected code snippet being changed - NOT the full document!

FORMAT:
:::artifactupdate{identifier="${artifact.identifier}" type="${artifact.type || 'text/html'}" title="${artifact.title || 'Updated Artifact'}"}
\`\`\`${getLanguageFromType(artifact.type)}
<ONLY THE SELECTED/CHANGED CODE - NO OTHER CODE>
\`\`\`
:::

❌ WRONG EXAMPLE (User asks "change background color to red"):
:::artifactupdate{...}
\`\`\`html
<!DOCTYPE html>
<html>
<head>...</head>
<body style="background: red;">...</body>
</html>
\`\`\`
:::

✅ CORRECT EXAMPLE (User asks "change background color to red"):
:::artifactupdate{...}
\`\`\`html
<body style="background: red;">
\`\`\`
:::

🚨 ABSOLUTE RULES - NO EXCEPTIONS:
1. Return ONLY the code lines/section user selected or wants to change
2. DO NOT return the full HTML/CSS/JS document
3. DO NOT include <!DOCTYPE>, <html>, <head>, or any unchanged sections
4. DO NOT add any code that wasn't in the user's selection
5. Match the user's selection EXACTLY - if they selected 3 lines, return ~3 lines
6. Think of this as "find and replace" - return ONLY the replacement text
7. NO explanations before or after the code block
8. IDENTIFIER: Use ${artifact.identifier || artifact.id} exactly as shown

IF YOU RETURN A FULL DOCUMENT INSTEAD OF A SNIPPET, THE SYSTEM WILL BREAK!
The code expects a small snippet to merge into the existing document, NOT a full document.`;

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
    <>
      <Tabs.Content value="code" id="artifacts-code" className={cn('flex-grow overflow-auto')}>
        <div ref={contentRef}>
          <ArtifactCodeEditor
            files={files}
            fileKey={fileKey}
            template={template}
            artifact={mergedArtifact || displayArtifact}
            editorRef={editorRef}
            sharedProps={sharedProps}
            onSelectionSubmit={handleSelectionSubmit}
          />
        </div>
      </Tabs.Content>
      <Tabs.Content
        value="preview"
        className={cn('flex-grow overflow-auto', isMermaid ? 'bg-[#282C34]' : 'bg-white')}
        key={`preview-${previewKey}`}
      >
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
    </>
  );
}
