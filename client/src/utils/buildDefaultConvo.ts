import {
  parseConvo,
  EModelEndpoint,
  isAssistantsEndpoint,
  isAgentsEndpoint,
  LocalStorageKeys,
} from 'librechat-data-provider';
import type { TConversation, EndpointSchemaKey } from 'librechat-data-provider';
import { getLocalStorageItems } from './localStorage';

const buildDefaultConvo = ({
  models,
  conversation,
  endpoint = null,
  lastConversationSetup,
  index = 0,
}: {
  models: string[];
  conversation: TConversation;
  endpoint?: EModelEndpoint | null;
  lastConversationSetup: TConversation | null;
  index?: number;
}): TConversation => {
  const { lastSelectedModel, lastSelectedTools } = getLocalStorageItems();
  const endpointType = lastConversationSetup?.endpointType ?? conversation.endpointType;

  if (!endpoint) {
    return {
      ...conversation,
      endpointType,
      endpoint,
    };
  }

  const availableModels = models;
  const model = lastConversationSetup?.model ?? lastSelectedModel?.[endpoint] ?? '';
  const secondaryModel: string | null =
    endpoint === EModelEndpoint.gptPlugins
      ? (lastConversationSetup?.agentOptions?.model ?? lastSelectedModel?.secondaryModel ?? null)
      : null;

  let possibleModels: string[], secondaryModels: string[];

  if (availableModels.includes(model)) {
    possibleModels = [model, ...availableModels];
  } else {
    possibleModels = [...availableModels];
  }

  if (secondaryModel != null && secondaryModel !== '' && availableModels.includes(secondaryModel)) {
    secondaryModels = [secondaryModel, ...availableModels];
  } else {
    secondaryModels = [...availableModels];
  }

  const convo = parseConvo({
    endpoint: endpoint as EndpointSchemaKey,
    endpointType: endpointType as EndpointSchemaKey,
    conversation: lastConversationSetup,
    possibleValues: {
      models: possibleModels,
      secondaryModels,
    },
  });

  const defaultConvo = {
    ...conversation,
    ...convo,
    endpointType,
    endpoint,
  };

  // Ensures assistant_id is always defined
  const assistantId = convo?.assistant_id ?? conversation?.assistant_id ?? '';
  const defaultAssistantId = lastConversationSetup?.assistant_id ?? '';
  if (isAssistantsEndpoint(endpoint) && !defaultAssistantId && assistantId) {
    defaultConvo.assistant_id = assistantId;
  }

  // Ensures agent_id is always defined
  const agentId = convo?.agent_id ?? conversation?.agent_id ?? '';
  const defaultAgentId = lastConversationSetup?.agent_id ?? '';
  const lastSelectedAgentId = localStorage.getItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`) ?? '';
  
  if (isAgentsEndpoint(endpoint)) {
    if (!defaultAgentId && (agentId || lastSelectedAgentId)) {
      // Use agent from convo, or fall back to last selected agent from localStorage
      defaultConvo.agent_id = agentId || lastSelectedAgentId;
    }
  }

  defaultConvo.tools = lastConversationSetup?.tools ?? lastSelectedTools ?? defaultConvo.tools;

  return defaultConvo;
};

export default buildDefaultConvo;
