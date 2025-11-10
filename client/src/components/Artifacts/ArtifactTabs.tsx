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

  // Get the artifact from state, or use the passed prop
  const stateArtifact = _artifacts?.[artifact.id] ?? artifact;

  // IMPORTANT: On refresh, reconstruct artifact by applying all updates to the base
  const mergedArtifact = React.useMemo(() => {
    if (!stateArtifact || !_artifacts) {
      return stateArtifact;
    }
    //if (!latestMessage?.content || !latestMessage.messageId) return;
    // If this is an update artifact, we need to merge all updates up to this point
    if (stateArtifact.isUpdate) {
      // Extract the base identifier from the artifact's identifier
      // Format is usually: baseId_type_title_messageId
      const baseIdentifier = stateArtifact.identifier?.split('_')[0];

      // Find the original (base) artifact by matching the base identifier
      const originalArtifact = _artifacts
        ? Object.values(_artifacts).find((a) => a && a.identifier === baseIdentifier && !a.isUpdate)
        : undefined;
      if (originalArtifact && originalArtifact.content !== artifact?.content) {
        console.log('🔄 [ArtifactTabs] Merging updates up to artifact:', {
          targetId: stateArtifact.id,
          baseId: originalArtifact.id,
          targetTime: stateArtifact.lastUpdateTime,
          baseIdentifier,
        });

        // Merge all updates up to and including this artifact
        const mergedContent = applyAllPartialUpdates(
          originalArtifact.content ?? '',
          _artifacts,
          stateArtifact.id, // Pass the target artifact ID to merge only up to this point
        );
        console.log('mergedContent merged artifact', mergedContent);

        //makes original code show updated content
        setCurrentCode(mergedContent);
        return {
          ...stateArtifact,
          content: mergedContent,
        };
      }
    }

    // If it's not an update or we couldn't find the base, return as-is
    return stateArtifact;
  }, [stateArtifact, _artifacts, artifact, setCurrentCode]);

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

  useEffect(() => {
    if (mergedArtifact && mergedArtifact.content) {
      setPreviewKey((prev) => prev + 1);
      setCurrentCode(mergedArtifact.content);
    }
  }, [mergedArtifact, setCurrentCode]);

  // Update currentCode when artifact content changes DO NOT TOUCH OTHERWISE IT BREAKS UPDATES
  useEffect(() => {
    if (currentCode === undefined) {
      const updateArtifact = artifact; // could be an update
      const baseIdentifier = updateArtifact.identifier?.split('_')[0];
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
        const mergedContent = applyAllPartialUpdates(
          originalArtifact.content,
          _artifacts,
          artifact.id,
        );
        console.log('mergedContent in useEffect', mergedContent);
        setCurrentCode(mergedContent);
      } else {
        setCurrentCode(artifact.content);
      }
    }
  }, [mergedArtifact, currentCode, setCurrentCode, artifact, _artifacts]);

  useEffect(() => {
    if (currentCode === undefined && mergedArtifact && mergedArtifact.content) {
      setCurrentCode(mergedArtifact.content);
    }
  }, [mergedArtifact, currentCode, setCurrentCode]);

  // Always update currentCode when artifact changes
  useEffect(() => {
    if (mergedArtifact && mergedArtifact.content) {
      setCurrentCode(mergedArtifact.content);
    }
  }, [mergedArtifact, setCurrentCode, currentCode]);

  const { submitMessage } = useSubmitMessage();
  const displayArtifact = artifactCache.getDisplayArtifact(artifact.id, _artifacts) || artifact;
  const content = displayArtifact?.content ?? '';
  const props = useArtifactProps({ artifact: displayArtifact });
  const files = { ...props.files };
  const fileKey = props.fileKey;
  const template = props.template;
  const sharedProps = props.sharedProps;

  // Override the main file's content with the merged content for the code editor
  if (files && fileKey && content) {
    files[fileKey] = { ...files[fileKey], code: content };
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
      const isUpdateRequest = messageData.isArtifactUpdate === true;

      const systemInstructions = isUpdateRequest
        ? `You are helping edit code in an artifact. 
When providing your updated code, use the artifactupdate directive format:

:::artifactupdate{identifier="${artifact.identifier}" type="${artifact.type || 'text/html'}" title="${artifact.title || 'Updated Artifact'}"}
\`\`\`${getLanguageFromType(artifact.type)}
[your updated code here]
\`\`\`
:::

IMPORTANT: 
- Use the exact identifier "${artifact.identifier || artifact.id}" from the existing artifact
- Only include the portion of code that should replace the selected section, not the entire artifact, DO NOT SEND BACK WHOLE ARTIFACT
- Make sure to look at the whole artifact from the previous message to understand the update context but only send the section that is updated back and make sure to keep all formatting to not break the artifact.
- Do not include any explanations before the artifactupdate directive or comments before the ::artifactupdate marker
- Keep spacing and everything from the artifact so it can be inserted correctly into the artifact
- Do not add any code that already exists in the artifact
- Make sure to test your changes before submitting.
- Never ask the user a question, just pick an answer and change it.
`
        : // General instructions for other types of requests
          `
You are helping with code. If you want to provide updated code that should replace the original section, use the artifactupdate directive format:

:::artifactupdate{identifier="${artifact.identifier}" type="${artifact.type || 'text/html'}" title="${artifact.title || 'Updated Artifact'}"}
\`\`\`${getLanguageFromType(artifact.type)}
[your updated code here]
\`\`\`
:::`;

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
  const [tabValue, setTabValue] = useState('preview');
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
            artifact={displayArtifact}
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
