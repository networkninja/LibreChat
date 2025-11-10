import { v4 } from 'uuid';
import { useCallback, useRef, useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Constants, replaceSpecialVars } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';
import store from '~/store';

const appendIndex = (index: number, value?: string) => {
  if (!value) {
    return value;
  }
  return `$${value}$${Constants.COMMON_DIVIDER}${index}`;
};

// Utility to extract code from responses
export function extractCodeFromResponse(response) {
  // Look for code blocks in markdown format
  const codeBlockRegex = /```(?:\w+)?\s*([\s\S]*?)```/g;
  const matches = [...response.matchAll(codeBlockRegex)];

  if (matches.length > 0) {
    return matches[0][1].trim(); // Return the content of the first code block
  }

  return response; // Return the full response if no code blocks found
}

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const methods = useChatFormContext();
  const { ask, index, getMessages, setMessages, latestMessage } = useChatContext();
  const { addedIndex, ask: askAdditional, conversation: addedConvo } = useAddedChatContext();

  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const activeConvos = useRecoilValue(store.allConversationsSelector);
  const setActivePrompt = useSetRecoilState(store.activePromptByIndex(index));

  // Store callbacks in a ref to access them when responses arrive
  const responseCallbacksRef = useRef(new Map());

  // Hook into message events to handle callbacks
  useEffect(() => {
    if (!latestMessage) return;
    console.log('latestMessage', latestMessage);
    const updateItem = latestMessage?.content.find(
      (item) =>
        item &&
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.includes('::artifactupdate'),
    );
    // Check if we have a callback for this message
    const messageKey = latestMessage.parentMessageId;
    console.log('messageKEy', messageKey, responseCallbacksRef.current);
    if (responseCallbacksRef.current.has(messageKey)) {
      // Get and execute the callback
      const callback = responseCallbacksRef.current.get(messageKey);
      console.log('callback', callback);
      if (typeof callback === 'function') {
        callback(latestMessage);

        // Remove the callback after execution
        responseCallbacksRef.current.delete(messageKey);
      }
    }
  }, [latestMessage]);

  const submitMessage = useCallback(
    (data?: {
      text:
        | string
        | {
            message: string;
            selectionContext?: {
              endColumn: number;
              endLine: number;
              fileKey: string;
              originalText: string;
              startColumn: number;
              startLine: number;
              artifactId?: string;
              artifactIndex?: number;
              artifactMessageId?: string;
            };
          };
      mcp?: boolean;
      artifactInfo?: {
        artifactId: string;
        artifactType: string;
      };
      systemInstructions?: string;
      onResponse?: (response: any) => void;
    }) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }
      let messageText = typeof data.text === 'string' ? data.text : data.text.message;
      const selectionContext =
        typeof data.text === 'object' ? data.text.selectionContext : undefined;

      // Prepare system instructions
      let systemInstructions = data.systemInstructions || '';
      console.log('selectionContect', selectionContext, data.systemInstructions);
      if (selectionContext) {
        // Add special system instructions for code section updates if not provided
        if (!systemInstructions) {
          systemInstructions = `You are being asked to help with a code section from the artifact ${selectionContext.fileKey}. 
The user has selected lines ${selectionContext.startLine}-${selectionContext.endLine}.
IMPORTANT: When you provide updated code, ONLY include the modified code snippet, not the entire file.
Format your response as a code block using triple backticks.
Do not include any explanatory text before or after the code block unless specifically asked.`;
        }

        // Create a reference to the selection context for the backend
        const artifactContext = `\n\nSelected code from ${selectionContext.fileKey} (lines ${selectionContext.startLine}-${selectionContext.endLine}):\n\`\`\`\n${selectionContext.originalText}\n\`\`\``;
        messageText = messageText + artifactContext;
      }

      // If artifact info is provided but no selection context, add general artifact instructions
      if (data.artifactInfo && !selectionContext && !systemInstructions) {
        systemInstructions = `You are helping with an artifact of type ${data.artifactInfo.artifactType}.
If you provide code updates, make sure they are wrapped in code blocks using triple backticks.`;
      }

      const rootMessages = getMessages();
      const isLatestInRootMessages = rootMessages?.some(
        (message) => message.messageId === latestMessage?.messageId,
      );
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages || []), latestMessage]);
      }

      const hasAdded = addedIndex && activeConvos[addedIndex] && addedConvo;
      const isNewMultiConvo =
        hasAdded &&
        activeConvos.every((convoId) => convoId === Constants.NEW_CONVO) &&
        !rootMessages?.length;
      const overrideConvoId = isNewMultiConvo ? v4() : undefined;
      const overrideUserMessageId = v4(); // Always generate a new message ID for tracking
      const rootIndex = addedIndex - 1;
      const clientTimestamp = new Date().toISOString();

      // Register callback if provided
      if (typeof data.onResponse === 'function') {
        responseCallbacksRef.current.set(overrideUserMessageId, data.onResponse);
      }

      ask({
        text: messageText,
        overrideConvoId: appendIndex(rootIndex, overrideConvoId),
        overrideUserMessageId: appendIndex(rootIndex, overrideUserMessageId),
        clientTimestamp,
        systemInstructions: systemInstructions || undefined,
        artifactSectionUpdate: selectionContext
          ? {
              fileKey: selectionContext.fileKey,
              originalText: selectionContext.originalText,
              startLine: selectionContext.startLine,
              endLine: selectionContext.endLine,
              startColumn: selectionContext.startColumn,
              endColumn: selectionContext.endColumn,
              artifactId: selectionContext.artifactId || data.artifactInfo?.artifactId,
              artifactIndex: selectionContext.artifactIndex,
              artifactMessageId: selectionContext.artifactMessageId,
            }
          : undefined,
      });

      if (hasAdded) {
        askAdditional(
          {
            text: messageText,
            overrideConvoId: appendIndex(addedIndex, overrideConvoId),
            overrideUserMessageId: appendIndex(addedIndex, overrideUserMessageId),
            clientTimestamp,
            systemInstructions: systemInstructions || undefined,
            artifactSectionUpdate: selectionContext
              ? {
                  fileKey: selectionContext.fileKey,
                  originalText: selectionContext.originalText,
                  startLine: selectionContext.startLine,
                  endLine: selectionContext.endLine,
                  startColumn: selectionContext.startColumn,
                  endColumn: selectionContext.endColumn,
                  artifactId: selectionContext.artifactId || data.artifactInfo?.artifactId,
                  artifactIndex: selectionContext.artifactIndex,
                  artifactMessageId: selectionContext.artifactMessageId,
                }
              : undefined,
          },
          { overrideMessages: rootMessages },
        );
      }
      methods.reset();
    },
    [
      ask,
      methods,
      addedIndex,
      addedConvo,
      setMessages,
      getMessages,
      activeConvos,
      askAdditional,
      latestMessage,
    ],
  );

  const submitPrompt = useCallback(
    (text: string, mcp?: boolean) => {
      const parsedText = replaceSpecialVars({ text, user });
      if (autoSendPrompts) {
        submitMessage({ text: parsedText, mcp: mcp });
        return;
      }

      const currentText = methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
    },
    [autoSendPrompts, submitMessage, setActivePrompt, methods, user],
  );

  // Utility to extract code from responses
  const extractCodeFromResponse = useCallback((response) => {
    if (!response) return '';

    // Handle different response formats
    const text = typeof response === 'string' ? response : response.text || response.content || '';

    // Look for code blocks in markdown format
    const codeBlockRegex = /```(?:\w+)?\s*([\s\S]*?)```/g;
    const matches = [...text.matchAll(codeBlockRegex)];

    if (matches.length > 0) {
      return matches[0][1].trim(); // Return the content of the first code block
    }

    return text; // Return the full response if no code blocks found
  }, []);

  return { submitMessage, submitPrompt, extractCodeFromResponse };
}
