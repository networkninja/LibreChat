import debounce from 'lodash/debounce';
import React, { createContext, useContext, useState, useMemo } from 'react';
import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { Endpoint, SelectedValues } from '~/common';
import {
  useAgentDefaultPermissionLevel,
  useSelectorEffects,
  useKeyDialog,
  useEndpoints,
} from '~/hooks';
import { useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { useGetEndpointsQuery, useListAgentsQuery } from '~/data-provider';
import { useModelSelectorChatContext } from './ModelSelectorChatContext';
import useSelectMention from '~/hooks/Input/useSelectMention';
import { filterItems } from './utils';

type ModelSelectorContextType = {
  // State
  searchValue: string;
  selectedValues: SelectedValues;
  endpointSearchValues: Record<string, string>;
  searchResults: (t.TModelSpec | Endpoint)[] | null;
  // LibreChat
  modelSpecs: t.TModelSpec[];
  mappedEndpoints: Endpoint[];
  agentsMap: t.TAgentsMap | undefined;
  assistantsMap: t.TAssistantsMap | undefined;
  endpointsConfig: t.TEndpointsConfig;

  // Functions
  endpointRequiresUserKey: (endpoint: string) => boolean;
  setSelectedValues: React.Dispatch<React.SetStateAction<SelectedValues>>;
  setSearchValue: (value: string) => void;
  setEndpointSearchValue: (endpoint: string, value: string) => void;
  handleSelectSpec: (spec: t.TModelSpec) => void;
  handleSelectEndpoint: (endpoint: Endpoint) => void;
  handleSelectModel: (endpoint: Endpoint, model: string) => void;
} & ReturnType<typeof useKeyDialog>;

const ModelSelectorContext = createContext<ModelSelectorContextType | undefined>(undefined);

export function useModelSelectorContext() {
  const context = useContext(ModelSelectorContext);
  if (context === undefined) {
    throw new Error('useModelSelectorContext must be used within a ModelSelectorProvider');
  }
  return context;
}

interface ModelSelectorProviderProps {
  children: React.ReactNode;
  startupConfig: t.TStartupConfig | undefined;
}

export function ModelSelectorProvider({ children, startupConfig }: ModelSelectorProviderProps) {
  const agentsMap = useAgentsMapContext();
  const assistantsMap = useAssistantsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { endpoint, model, spec, agent_id, assistant_id, conversation, newConversation } =
    useModelSelectorChatContext();
  const modelSpecs = useMemo(() => {
    const specs = startupConfig?.modelSpecs?.list ?? [];
    if (!agentsMap) {
      return specs;
    }

    /**
     * Filter modelSpecs to only include agents the user has access to.
     * Use agentsMap which already contains permission-filtered agents (consistent with other components).
     */
    return specs.filter((spec) => {
      if (spec.preset?.endpoint === EModelEndpoint.agents && spec.preset?.agent_id) {
        return spec.preset.agent_id in agentsMap;
      }
      /** Keep non-agent modelSpecs */
      return true;
    });
  }, [startupConfig, agentsMap]);

  const permissionLevel = useAgentDefaultPermissionLevel();
  const { data: agents = null } = useListAgentsQuery(
    { requiredPermission: permissionLevel },
    {
      select: (data) => data?.data,
    },
  );

  const { mappedEndpoints, endpointRequiresUserKey } = useEndpoints({
    agents,
    assistantsMap,
    startupConfig,
    endpointsConfig,
  });

  const { onSelectEndpoint, onSelectSpec } = useSelectMention({
    // presets,
    modelSpecs,
    conversation,
    assistantsMap,
    endpointsConfig,
    newConversation,
    returnHandlers: true,
  });

  // State - Initialize from conversation context OR localStorage
  const [selectedValues, setSelectedValues] = useState<SelectedValues>(() => {
    // Try to get values from conversation context first
    let initialEndpoint = endpoint || '';
    let initialModel = model || '';
    let initialSpec = spec || '';

    // If no conversation values, try localStorage as fallback
    if (!initialEndpoint || !initialModel) {
      try {
        const lastConvoSetup = localStorage.getItem('lastConversationSetup_0');
        if (lastConvoSetup) {
          const parsed = JSON.parse(lastConvoSetup);
          initialEndpoint = initialEndpoint || parsed.endpoint || '';
          initialModel = initialModel || parsed.model || '';
          initialSpec = initialSpec || parsed.spec || '';
        }
      } catch (e) {
        console.error('Failed to parse lastConversationSetup from localStorage:', e);
      }
    }

    return {
      endpoint: initialEndpoint,
      model: initialModel,
      modelSpec: initialSpec,
    };
  });

  // Debug: Log when conversation changes
  React.useEffect(() => {
    console.log('🔍 [ModelSelectorContext] Conversation changed:', {
      endpoint,
      model,
      spec,
      agent_id,
      assistant_id,
      conversation,
    });
  }, [endpoint, model, spec, agent_id, assistant_id, conversation]);

  useSelectorEffects({
    agentsMap,
    conversation: endpoint
      ? ({
          endpoint: endpoint ?? null,
          model: model ?? null,
          spec: spec ?? null,
          agent_id: agent_id ?? null,
          assistant_id: assistant_id ?? null,
        } as any)
      : null,
    assistantsMap,
    setSelectedValues,
  });

  const [searchValue, setSearchValueState] = useState('');
  const [endpointSearchValues, setEndpointSearchValues] = useState<Record<string, string>>({});

  const keyProps = useKeyDialog();

  /** Memoized search results */
  const searchResults = useMemo(() => {
    if (!searchValue) {
      return null;
    }
    const allItems = [...modelSpecs, ...mappedEndpoints];
    return filterItems(allItems, searchValue, agentsMap, assistantsMap || {});
  }, [searchValue, modelSpecs, mappedEndpoints, agentsMap, assistantsMap]);

  const setDebouncedSearchValue = useMemo(
    () =>
      debounce((value: string) => {
        setSearchValueState(value);
      }, 200),
    [],
  );
  const setEndpointSearchValue = (endpoint: string, value: string) => {
    setEndpointSearchValues((prev) => ({
      ...prev,
      [endpoint]: value,
    }));
  };

  const handleSelectSpec = (spec: t.TModelSpec) => {
    let model = spec.preset.model ?? null;
    onSelectSpec?.(spec);
    if (isAgentsEndpoint(spec.preset.endpoint)) {
      model = spec.preset.agent_id ?? '';
    } else if (isAssistantsEndpoint(spec.preset.endpoint)) {
      model = spec.preset.assistant_id ?? '';
    }

    // Save to localStorage immediately when user selects a model spec
    if (model && spec.preset.endpoint) {
      const lastModel = JSON.parse(localStorage.getItem('lastSelectedModel') ?? '{}');
      lastModel[spec.preset.endpoint] = model;
      localStorage.setItem('lastSelectedModel', JSON.stringify(lastModel));
      console.log('🔍 [handleSelectSpec] Saved to localStorage:', lastModel);
    }

    setSelectedValues({
      endpoint: spec.preset.endpoint,
      model,
      modelSpec: spec.name,
    });
  };

  const handleSelectEndpoint = (endpoint: Endpoint) => {
    if (!endpoint.hasModels) {
      if (endpoint.value) {
        onSelectEndpoint?.(endpoint.value);
      }
      setSelectedValues({
        endpoint: endpoint.value,
        model: '',
        modelSpec: '',
      });
    }
  };

  const handleSelectModel = (endpoint: Endpoint, model: string) => {
    let modelToSave = model;
    if (isAgentsEndpoint(endpoint.value)) {
      // Check if this is a saved agent ID or a direct model selection
      const agentData = agentsMap?.[model];
      if (agentData) {
        // This is a saved agent (with or without explicit model)
        // For agents, the backend determines the model from agent config
        // So we pass the agent_id and let the backend handle the model
        modelToSave = agentData.model || ''; // Use agent's model if available, else empty
        console.log(
          '🔍 [handleSelectModel] Saved agent selected, model:',
          modelToSave || 'determined by agent config',
        );
        onSelectEndpoint?.(endpoint.value, {
          agent_id: model,
          model: modelToSave,
        });
      } else {
        // This is a direct model selection for ephemeral agent
        modelToSave = model;
        onSelectEndpoint?.(endpoint.value, {
          model: modelToSave,
          agent_id: '', // Explicitly clear agent_id for ephemeral agents
      });
      }
    } else if (isAssistantsEndpoint(endpoint.value)) {
      // For assistants, save the assistant's underlying model
      modelToSave = assistantsMap?.[endpoint.value]?.[model]?.model ?? model;
      onSelectEndpoint?.(endpoint.value, {
        assistant_id: model,
        model: modelToSave,
      });
    } else if (endpoint.value) {
      onSelectEndpoint?.(endpoint.value, { model });
    }

    // Save the actual model (not agent_id/assistant_id) to localStorage
    const lastModel = JSON.parse(localStorage.getItem('lastSelectedModel') ?? '{}');
    lastModel[endpoint.value] = modelToSave;
    localStorage.setItem('lastSelectedModel', JSON.stringify(lastModel));

    // Save a timestamp to prevent storeEndpointSettings from overwriting this selection
    localStorage.setItem('lastModelSelectionTime', Date.now().toString());
    console.log('🔍 [handleSelectModel] Saved to localStorage:', lastModel);

    setSelectedValues({
      endpoint: endpoint.value,
      model,
      modelSpec: '',
    });
  };

  const value = {
    // State
    searchValue,
    searchResults,
    selectedValues,
    endpointSearchValues,
    // LibreChat
    agentsMap,
    modelSpecs,
    assistantsMap,
    mappedEndpoints,
    endpointsConfig,

    // Functions
    handleSelectSpec,
    handleSelectModel,
    setSelectedValues,
    handleSelectEndpoint,
    setEndpointSearchValue,
    endpointRequiresUserKey,
    setSearchValue: setDebouncedSearchValue,
    // Dialog
    ...keyProps,
  };

  return <ModelSelectorContext.Provider value={value}>{children}</ModelSelectorContext.Provider>;
}
