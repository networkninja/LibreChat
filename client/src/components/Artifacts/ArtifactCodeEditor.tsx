import debounce from 'lodash/debounce';
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  useSandpack,
  SandpackCodeEditor,
  SandpackProvider as StyledProvider,
} from '@codesandbox/sandpack-react';
import type { SandpackProviderProps } from '@codesandbox/sandpack-react/unstyled';
import type { SandpackBundlerFile } from '@codesandbox/sandpack-client';
import type { CodeEditorRef } from '@codesandbox/sandpack-react';
import type { ArtifactFiles, Artifact } from '~/common';
import { useEditArtifact, useGetStartupConfig } from '~/data-provider';
import { useEditorContext, useArtifactsContext } from '~/Providers';
import { sharedFiles, sharedOptions } from '~/utils/artifacts';
import { logger } from '~/utils';
import { useLocalize } from '~/hooks';
import { artifactCache } from './ArtifactCache';
import { useRecoilValue } from 'recoil';
import { artifactsState } from '~/store/artifacts';
// Export the centralized artifact cache
export { artifactCache } from './ArtifactCache';

const createDebouncedMutation = (
  callback: (params: {
    index: number;
    messageId: string;
    original: string;
    updated: string;
  }) => void,
) => debounce(callback, 500);

export type selectionContext = {
  fileKey: string;
  originalText: string;
  updatedText?: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  artifactId?: string;
  artifactIndex?: number;
  artifactMessageId?: string;
  timestamp?: number; // Add timestamp for cache invalidation
};

// Note: Using centralized artifactCache instead of local cache

const CodeEditor = ({
  fileKey,
  readOnly,
  artifact,
  editorRef,
  onSelectionSubmit,
}: {
  fileKey: string;
  readOnly?: boolean;
  artifact: Artifact;
  editorRef: React.MutableRefObject<CodeEditorRef>;
  onSelectionSubmit?: (message: any) => void;
}) => {
  const { sandpack } = useSandpack();
  const [currentUpdate, setCurrentUpdate] = useState<string | null>(null);
  const { isMutating, setIsMutating, setCurrentCode } = useEditorContext();
  const [showSelectionTooltip, setShowSelectionTooltip] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<string>('');
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const localize = useLocalize();
  const [lastEditSource, setLastEditSource] = useState<
    'external' | 'undo' | 'redo' | 'user' | null
  >(null);
  const [isLocallyEdited, setIsLocallyEdited] = useState(false);
  const [lastArtifactId, setLastArtifactId] = useState<string | null>(artifact.id ?? null);
  const allArtifacts = useRecoilValue(artifactsState);

  // Local ref to track current selection info
  const selectionInfoRef = useRef<{
    text: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  } | null>(null);

  const [selectionInfo, setSelectionInfo] = useState<{
    text: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  } | null>(null);

  const customPromptInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (customPromptOpen && customPromptInputRef.current) {
      customPromptInputRef.current.focus();
    }
  }, [customPromptOpen]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (customPrompt.trim()) {
        handleCustomPromptSubmit();
      }
    }
  };

  const editArtifact = useEditArtifact({
    onMutate: (vars) => {
      setIsMutating(true);
      setCurrentUpdate(vars.updated);
    },
    onSuccess: () => {
      setIsMutating(false);
      setCurrentUpdate(null);
    },
    onError: () => {
      setIsMutating(false);
    },
  });

  const mutationCallback = useCallback(
    (params: { index: number; messageId: string; original: string; updated: string }) => {
      editArtifact.mutate(params);
    },
    [editArtifact],
  );

  const debouncedMutation = useMemo(
    () => createDebouncedMutation(mutationCallback),
    [mutationCallback],
  );

  // Get prompt templates based on artifact type
  const getPromptTemplates = useCallback(() => {
    const isCode = /code|py|js|ts|jsx|tsx|java|c|cpp|cs|html|rb|go|rs|php/i.test(
      artifact.type || '',
    );

    const commonPrompts = [
      { label: '🔍 Explain this', value: 'Please explain this code section:' },
      { label: '🐞 Find issues', value: 'Are there any bugs or issues in this code?' },
      { label: '⚡ Optimize', value: 'How could this code be optimized?' },
      {
        label: '✏️ Update section',
        value: 'Please update this code section to improve it:',
        isUpdate: true,
      },
    ];

    if (!isCode) {
      // Add text-specific prompts
      commonPrompts.push({ label: 'Summarize', value: 'Please summarize this text:' });
    }

    return commonPrompts;
  }, [artifact.type]);

  // ...inside CodeEditor component, before return...

  // Undo/Redo stack for code editor content
  const [codeUndoStack, setCodeUndoStack] = useState<string[]>([]);
  const [codeRedoStack, setCodeRedoStack] = useState<string[]>([]);

  // Helper to get the artifact chain (sorted by lastUpdateTime)
  function getArtifactChain() {
    if (!allArtifacts || !artifact.identifier) return [];
    return Object.values(allArtifacts)
      .filter((a) => a?.identifier === artifact.identifier)
      .sort((a, b) => (a?.lastUpdateTime ?? 0) - (b?.lastUpdateTime ?? 0));
  }

  function getCurrentArtifactIndex(chain: Artifact[]) {
    return chain.findIndex((a) => a.id === artifact.id);
  }

  function handleUndoArtifact() {
    const chain = getArtifactChain();
    const idx = getCurrentArtifactIndex(chain.filter((a): a is Artifact => a !== undefined));
    if (idx > 0) {
      const prev = chain[idx - 1];
      setCurrentCode(prev?.content);
      sandpack.updateFile('/' + fileKey, prev?.content);
      // Optionally, update artifact selection in your global state
    }
  }

  function handleRedoArtifact() {
    const chain = getArtifactChain();
    const idx = getCurrentArtifactIndex(chain.filter((a): a is Artifact => a !== undefined));
    if (idx < chain.length - 1) {
      const next = chain[idx + 1];
      setCurrentCode(next?.content);
      sandpack.updateFile('/' + fileKey, next?.content);
      // Optionally, update artifact selection in your global state
    }
  }

  const handleEditorChange = useCallback(
    (code: string) => {
      // Only push to undo stack if the code actually changed
      setCodeUndoStack((prev) =>
        prev.length === 0 || prev[prev.length - 1] !== code ? [...prev, code] : prev,
      );
      setCodeRedoStack([]); // Clear redo stack on new input
      setCurrentCode(code);
      sandpack.updateFile('/' + fileKey, code);
      setIsLocallyEdited(true);
      setLastEditSource('user');

      // Clear the selection cache when user manually edits the artifact
      // This prevents stale cached selections from being used in subsequent updates
      if (artifact?.id) {
        console.log(
          '🧹 [ArtifactCodeEditor] Clearing selection cache due to manual edit:',
          artifact.id,
        );
        artifactCache.clearSelection(artifact.id.toLowerCase());
      }
    },
    [setCurrentCode, sandpack, fileKey, artifact?.id],
  );

  // Handle selection changes
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const selectedText = selection.toString().trim();

      if (selectedText.length > 0) {
        const editorElement = editorContainerRef.current;

        if (
          editorElement &&
          editorElement.contains(selection.getRangeAt(0).commonAncestorContainer)
        ) {
          // Get selection coordinates to position the tooltip
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          const editorRect = editorElement.getBoundingClientRect();

          // Get tooltip dimensions (estimated if not yet rendered)
          const tooltipWidth = tooltipRef.current
            ? tooltipRef.current.offsetWidth
            : Math.min(500, rect.width * 2); // Estimate based on selection width
          const tooltipHeight = tooltipRef.current ? tooltipRef.current.offsetHeight : 150; // Estimated default height

          // Calculate initial position
          let tooltipTop = rect.top - editorRect.top - 10;
          let tooltipLeft = rect.left - editorRect.left + rect.width / 2;

          // --- Tooltip boundary checks ---
          // Move tooltip further to the left, but keep it inside the editor
          tooltipLeft = rect.left - editorRect.left; // Align tooltip to left edge of selection
          if (tooltipLeft + tooltipWidth > editorRect.width) {
            tooltipLeft = editorRect.width - tooltipWidth - 10; // 10px margin from right
          }
          if (tooltipLeft < 10) {
            tooltipLeft = 10; // 10px margin from left
          }
          // If tooltip goes off the top, show below selection
          if (tooltipTop < 0) {
            tooltipTop = rect.bottom - editorRect.top + 10;
          }
          // If tooltip goes off the bottom, move up
          if (tooltipTop + tooltipHeight > editorRect.height) {
            tooltipTop = Math.max(editorRect.height - tooltipHeight - 10, 0);
          }

          setTooltipPosition({
            top: tooltipTop,
            left: tooltipLeft,
          });

          // Get current code to find line/column positions
          const currentCode =
            (sandpack.files['/' + fileKey] as SandpackBundlerFile | undefined)?.code || '';
          const lines = currentCode.split('\n');

          // Find the position of the selected text in the code using improved logic
          let startLine = -1,
            endLine = -1,
            startColumn = -1,
            endColumn = -1;

          // Split selected text into lines for better matching
          const selectedLines = selectedText.split('\n');

          // Search for the exact position by comparing full content
          const selectedTextIndex = currentCode.indexOf(selectedText);

          if (selectedTextIndex !== -1) {
            // Calculate line and column from character index
            const beforeSelection = currentCode.substring(0, selectedTextIndex);
            const beforeLines = beforeSelection.split('\n');

            startLine = beforeLines.length - 1; // 0-based line index
            startColumn = beforeLines[beforeLines.length - 1].length; // Column position

            // Calculate end position
            endLine = startLine + selectedLines.length - 1;
            endColumn =
              selectedLines.length === 1
                ? startColumn + selectedText.length
                : selectedLines[selectedLines.length - 1].length;

            console.log('📍 [ArtifactCodeEditor] Calculated selection positions (exact match):', {
              selectedTextIndex,
              startLine,
              endLine,
              startColumn,
              endColumn,
              totalLines: lines.length,
              selectedTextPreview: selectedText.substring(0, 50) + '...',
            });
          } else {
            // Method 2: Fallback - try to find approximate position
            console.warn('⚠️ [ArtifactCodeEditor] Exact text match failed, using fallback');
            const firstNonEmptyLine = selectedLines.find((line) => line.trim().length > 0);

            if (firstNonEmptyLine) {
              for (let i = 0; i < lines.length; i++) {
                const lineIndex = lines[i].indexOf(firstNonEmptyLine.trim());
                if (lineIndex !== -1) {
                  startLine = i;
                  startColumn = lineIndex;
                  endLine = Math.min(startLine + selectedLines.length - 1, lines.length - 1);
                  endColumn =
                    selectedLines.length === 1
                      ? startColumn + firstNonEmptyLine.length
                      : selectedLines[selectedLines.length - 1].length;

                  console.log('📍 [ArtifactCodeEditor] Used fallback selection positions:', {
                    startLine,
                    endLine,
                    startColumn,
                    endColumn,
                    matchedLine: firstNonEmptyLine.substring(0, 30) + '...',
                  });
                  break;
                }
              }
            }

            // Method 3: Last resort - use safe defaults
            if (startLine === -1) {
              console.warn(
                '⚠️ [ArtifactCodeEditor] Could not locate selection, using safe defaults',
              );
              startLine = 0;
              endLine = 0;
              startColumn = 0;
              endColumn = selectedText.length;
            }
          }

          const newSelectionInfo = {
            text: selectedText,
            startLine,
            endLine,
            startColumn,
            endColumn,
          };

          // Prevent redundant updates and infinite loops
          // const lastSelection = selectionInfoRef.current;
          // const isSameSelection =
          //   lastSelection &&
          //   lastSelection.text === newSelectionInfo.text &&
          //   lastSelection.startLine === newSelectionInfo.startLine &&
          //   lastSelection.endLine === newSelectionInfo.endLine;

          // if (!isSameSelection) {
          setSelectionInfo(newSelectionInfo);
          console.log('setSSelectionInfo', artifact.id, newSelectionInfo);
          // selectionInfoRef.current = newSelectionInfo;
          // setCurrentSelection(selectedText);
          // setShowSelectionTooltip(true);
          // Only cache if changed
          if (artifact?.id) {
            artifactCache.setSelection(artifact.id.toLowerCase(), {
              fileKey,
              originalText: selectedText,
              startLine,
              endLine,
              startColumn,
              endColumn,
              artifactId: artifact.id.toLowerCase(),
              artifactIndex: artifact.index,
              artifactMessageId: artifact.messageId?.toLowerCase(),
            });
          }

          // Also update the ref for immediate access
          selectionInfoRef.current = newSelectionInfo;

          setCurrentSelection(selectedText);
          setShowSelectionTooltip(true);
        }
      } else {
        if (tooltipRef.current && !tooltipRef.current.contains(document.activeElement)) {
          setShowSelectionTooltip(false);
          setCustomPromptOpen(false);
          setSelectionInfo(null);
        }
      }
    };

    // Handle clicks outside of the tooltip
    const handleClickOutside = (event: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setShowSelectionTooltip(false);
        setCustomPromptOpen(false);
      }
    };

    document.addEventListener('mouseup', handleSelectionChange);
    document.addEventListener('keyup', handleSelectionChange);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mouseup', handleSelectionChange);
      document.removeEventListener('keyup', handleSelectionChange);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [artifact.id, artifact.index, artifact.messageId, fileKey, sandpack.files]);

  // Function to submit selected text to the LLM with a prompt
  const submitToLLM = useCallback(
    (promptTemplate: string, isUpdate = false) => {
      if (!currentSelection || !onSelectionSubmit || !selectionInfo) return;

      console.log('promptTemplate', promptTemplate, 'isUpdate:', isUpdate);

      // Create the message with the code selection
      const message = `${promptTemplate}

\`\`\`${artifact.type || 'text'}
${currentSelection}
\`\`\``;

      // Create selection context
      const context = {
        fileKey,
        originalText: currentSelection,
        startLine: selectionInfo.startLine,
        endLine: selectionInfo.endLine,
        startColumn: selectionInfo.startColumn,
        endColumn: selectionInfo.endColumn,
        artifactId: artifact.id,
        artifactIndex: artifact.index,
        artifactMessageId: artifact.messageId,
        timestamp: Date.now(),
      };

      // Cache the selection context if this is an update request
      if (isUpdate && artifact.id) {
        console.log('setSelection', artifact.id, context);
        // Use the centralized artifact cache instead of local cache
        artifactCache.setSelection(artifact.id, context);
        console.log(
          '🟢 [ArtifactCodeEditor] Cached selection context for artifact:',
          artifact.id,
          context,
        );

        // Also cache the selected content with line information using the enhanced cache
        if (currentSelection && selectionInfo) {
          artifactCache.setContentWithLines(
            artifact.id,
            currentSelection,
            {
              startLine: selectionInfo.startLine,
              endLine: selectionInfo.endLine,
              startColumn: selectionInfo.startColumn,
              endColumn: selectionInfo.endColumn,
            },
            {
              title: artifact.title,
              type: artifact.type,
              identifier: artifact.identifier,
              source: 'editor',
            },
          );
          console.log('Cached selected content with line info for future updates');
        }
      }

      // Include all necessary context for updating the artifact
      const messageObject = {
        message,
        selectionContext: context,
        isArtifactUpdate: isUpdate,
      };

      console.log('Submitting selection with context:', messageObject, context);

      // Send the selection data for processing
      onSelectionSubmit(messageObject);

      setShowSelectionTooltip(false);
      setCustomPromptOpen(false);
      setCustomPrompt('');
      setSelectionInfo(null); // <-- This clears highlight only after submit

      // Clear the selection
      window.getSelection()?.removeAllRanges();

      logger.log('artifacts', 'Submitted selection to LLM for editing');
    },
    [currentSelection, artifact, onSelectionSubmit, selectionInfo, fileKey],
  );

  // Function to handle custom prompt submission
  const handleCustomPromptSubmit = useCallback(() => {
    if (!customPrompt.trim()) return;
    submitToLLM(customPrompt, true);
  }, [customPrompt, submitToLLM]);

  // Function to copy selection to clipboard
  const copySelectionToClipboard = useCallback(async () => {
    if (!currentSelection) return;

    try {
      await navigator.clipboard.writeText(currentSelection);
      logger.log('artifacts', 'Selection copied to clipboard');
      // Show brief visual feedback
      setShowSelectionTooltip(false);
    } catch (error) {
      logger.error('artifacts', 'Failed to copy selection:', error);
    }
  }, [currentSelection]);

  // Listen to Sandpack file changes and trigger handleEditorChange
  useEffect(() => {
    const currentCode = (sandpack.files['/' + fileKey] as SandpackBundlerFile | undefined)?.code;

    if (currentCode && currentCode !== artifact.content && lastEditSource !== 'user') {
      handleEditorChange(currentCode);
    }
  }, [sandpack.files, fileKey, artifact.content, lastEditSource, handleEditorChange]);

  useEffect(() => {
    if (readOnly) {
      return;
    }
    if (isMutating) {
      return;
    }
    if (artifact.index == null) {
      return;
    }

    const currentCode = (sandpack.files['/' + fileKey] as SandpackBundlerFile | undefined)?.code;
    const isNotOriginal =
      currentCode && artifact.content != null && currentCode.trim() !== artifact.content.trim();
    const isNotRepeated =
      currentUpdate == null
        ? true
        : currentCode != null && currentCode.trim() !== currentUpdate.trim();

    if (artifact.content && isNotOriginal && isNotRepeated) {
      setCurrentCode(currentCode);
      debouncedMutation({
        index: artifact.index,
        messageId: artifact.messageId ?? '',
        original: artifact.content,
        updated: currentCode,
      });
    }

    return () => {
      debouncedMutation.cancel();
    };
  }, [
    fileKey,
    artifact.index,
    artifact.content,
    artifact.messageId,
    readOnly,
    isMutating,
    currentUpdate,
    setIsMutating,
    sandpack.files,
    setCurrentCode,
    debouncedMutation,
  ]);

  return (
    <div ref={editorContainerRef} className="relative">
      <SandpackCodeEditor
        ref={editorRef}
        showTabs={false}
        showRunButton={false}
        showLineNumbers={true}
        showInlineErrors={true}
        readOnly={readOnly === true}
        className="hljs language-javascript bg-black"
      />

      {/* Floating selection tooltip */}
      {showSelectionTooltip && (
        <div
          ref={tooltipRef}
          className="absolute z-10 rounded-md border border-gray-700 bg-gray-800 p-2 shadow-lg"
          style={{
            top: `${tooltipPosition.top}px`,
            left: `${tooltipPosition.left}px`,
            // Remove translateX(-50%) and handle centering in JS
            maxWidth: '1250px',
            minWidth: '50%',
            width: 'auto',
          }}
        >
          <div
            style={{
              minHeight: 120,
              width: '400px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-start',
            }}
          >
            {!customPromptOpen ? (
              <>
                <div className="mb-1 flex flex-wrap gap-1 whitespace-nowrap">
                  {getPromptTemplates().map((prompt) => (
                    <button
                      key={prompt.value}
                      onClick={() => submitToLLM(prompt.value, prompt.isUpdate)}
                      className={`m-1 rounded px-2 py-2 text-xs ${
                        prompt.isUpdate
                          ? 'bg-green-600 text-white hover:bg-green-700'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1 flex gap-1 border-t border-gray-700 pt-1">
                  <button
                    onClick={() => setCustomPromptOpen(true)}
                    className="m-1 rounded bg-gray-700 px-2 py-2 text-xs text-gray-300 hover:bg-gray-600"
                  >
                    {localize('com_ui_artifacts_custom')}
                  </button>
                  <button
                    onClick={copySelectionToClipboard}
                    className="m-1 rounded bg-gray-700 px-2 py-2 text-xs text-gray-300 hover:bg-gray-600"
                  >
                    {localize('com_ui_copy_code')}
                  </button>
                  <button
                    onClick={() => setShowSelectionTooltip(false)}
                    className="ml-auto rounded bg-red-700 px-2 py-1 text-xs text-red-300 hover:bg-red-600"
                    aria-label={localize('com_ui_close')}
                  >
                    ×
                  </button>
                </div>
              </>
            ) : (
              <div className="flex h-full w-full flex-col gap-2">
                <textarea
                  value={customPrompt}
                  name="customField"
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter your custom prompt..."
                  className="w-full flex-1 resize-none rounded border border-gray-600 bg-gray-800 p-2 text-sm text-gray-300 ring-2 ring-blue-500 focus:ring-4 focus:ring-blue-400"
                  rows={4}
                />
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setCustomPromptOpen(false)}
                    className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-600"
                  >
                    {localize('com_ui_cancel')}
                  </button>
                  <button
                    onClick={handleCustomPromptSubmit}
                    disabled={!customPrompt.trim()}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {localize('com_ui_submit')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const ArtifactCodeEditor = function ({
  files,
  fileKey,
  template,
  artifact,
  editorRef,
  sharedProps,
  onSelectionSubmit,
}: {
  fileKey: string;
  artifact: Artifact;
  files: ArtifactFiles;
  template: SandpackProviderProps['template'];
  sharedProps: Partial<SandpackProviderProps>;
  editorRef: React.MutableRefObject<CodeEditorRef>;
  onSelectionSubmit?: (message: any) => void;
}) {
  const { data: config } = useGetStartupConfig();
  const { isSubmitting } = useArtifactsContext();
  const options: typeof sharedOptions = useMemo(() => {
    if (!config) {
      return sharedOptions;
    }
    return {
      ...sharedOptions,
      bundlerURL: template === 'static' ? config.staticBundlerURL : config.bundlerURL,
    };
  }, [config, template]);
  const [readOnly, setReadOnly] = useState(isSubmitting ?? false);
  useEffect(() => {
    setReadOnly(isSubmitting ?? false);
  }, [isSubmitting]);

  if (Object.keys(files).length === 0) {
    return null;
  }

  // Always use the display artifact (merged/cached if available)
  const displayArtifact =
    artifactCache.getDisplayArtifact(artifact?.id, { [artifact?.id]: artifact }) || artifact;

  return (
    <StyledProvider
      theme="dark"
      files={{
        ...files,
        ...sharedFiles,
      }}
      options={options}
      {...sharedProps}
      template={template}
    >
      <CodeEditor
        fileKey={fileKey}
        artifact={displayArtifact}
        editorRef={editorRef}
        readOnly={readOnly}
        onSelectionSubmit={onSelectionSubmit}
      />
    </StyledProvider>
  );
};
