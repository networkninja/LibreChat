export interface CodeBlock {
  id: string;
  language: string;
  content: string;
}

export interface Artifact {
  id: string;
  lastUpdateTime: number;
  index?: number;
  messageId?: string;
  conversationId?: string; // Track which conversation this artifact belongs to
  identifier?: string;
  originalIdentifier?: string;
  language?: string;
  content?: string;
  snippetContent?: string;
  title?: string;
  type?: string;
  updatedContent?: string;
  isUpdate?: boolean;
  isMerged?: boolean;
}

export interface SelectionRange {
  start: number;
  end: number;
  selectedText: string;
}

export interface ArtifactSelection {
  artifactId: string;
  selections: SelectionRange[];
}

export interface SelectableArtifactProps {
  content: string;
  language?: string;
  onSelectionChange?: (selection: SelectionRange | null) => void;
  allowMultipleSelections?: boolean;
}

export type ArtifactFiles =
  | {
      'App.tsx': string;
      'index.tsx': string;
      '/components/ui/MermaidDiagram.tsx': string;
    }
  | Partial<{
      [x: string]: string | undefined;
    }>;
