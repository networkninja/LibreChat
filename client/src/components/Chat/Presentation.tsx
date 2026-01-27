import { useRecoilValue, useSetRecoilState } from 'recoil';
import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { FileSources, LocalStorageKeys } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useDeleteFilesMutation } from '~/data-provider';
import DragDropWrapper from '~/components/Chat/Input/Files/DragDropWrapper';
import { EditorProvider, SidePanelProvider, ArtifactsProvider } from '~/Providers';
import Artifacts from '~/components/Artifacts/Artifacts';
import { SidePanelGroup } from '~/components/SidePanel';
import { useSetFilesToDelete } from '~/hooks';
import { loadArtifactsFromStorage } from '~/store/artifacts';
import store from '~/store';

export default function Presentation({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const artifacts = useRecoilValue(store.artifactsState);
  const artifactsVisibility = useRecoilValue(store.artifactsVisibility);
  const setArtifacts = useSetRecoilState(store.artifactsState);

  const setFilesToDelete = useSetFilesToDelete();

  // CRITICAL: Load artifacts from localStorage EARLY on mount
  // This ensures artifacts are available BEFORE the visibility gate check
  useEffect(() => {
    const conversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;

    if (!conversationId) {
      return;
    }

    // CRITICAL: Don't load artifacts for new conversations
    // The "new" conversation should always start fresh with no artifacts
    if (conversationId === 'new') {
      console.log('🆕 [Presentation] New conversation - skipping artifact load');
      return;
    }

    // Only load if artifacts are currently empty
    // Use a ref check to prevent infinite loops
    if (Object.keys(artifacts ?? {}).length === 0) {
      console.log(
        '🔄 [Presentation] Loading artifacts from localStorage on mount:',
        conversationId,
      );
      const storedArtifacts = loadArtifactsFromStorage(conversationId);

      if (storedArtifacts && Object.keys(storedArtifacts).length > 0) {
        console.log('✅ [Presentation] Loaded artifacts from storage:', {
          count: Object.keys(storedArtifacts).length,
          keys: Object.keys(storedArtifacts),
        });
        setArtifacts(storedArtifacts);
      } else {
        console.log(
          'ℹ️ [Presentation] No stored artifacts found for conversation:',
          conversationId,
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]); // Only depend on pathname, not artifacts!

  const { mutateAsync } = useDeleteFilesMutation({
    onSuccess: () => {
      console.log('Temporary Files deleted');
      setFilesToDelete({});
    },
    onError: (error) => {
      console.log('Error deleting temporary files:', error);
    },
  });

  useEffect(() => {
    const filesToDelete = localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE);
    const map = JSON.parse(filesToDelete ?? '{}') as Record<string, ExtendedFile>;
    const files = Object.values(map)
      .filter(
        (file) =>
          file.filepath != null && file.source && !(file.embedded ?? false) && file.temp_file_id,
      )
      .map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath as string,
        source: file.source as FileSources,
        embedded: !!(file.embedded ?? false),
      }));

    if (files.length === 0) {
      return;
    }
    mutateAsync({ files });
  }, [mutateAsync]);

  const defaultLayout = useMemo(() => {
    const resizableLayout = localStorage.getItem('react-resizable-panels:layout');
    return typeof resizableLayout === 'string' ? JSON.parse(resizableLayout) : undefined;
  }, []);
  const defaultCollapsed = useMemo(() => {
    const collapsedPanels = localStorage.getItem('react-resizable-panels:collapsed');
    return typeof collapsedPanels === 'string' ? JSON.parse(collapsedPanels) : true;
  }, []);
  const fullCollapse = useMemo(() => localStorage.getItem('fullPanelCollapse') === 'true', []);
  const artifactsElement = useMemo(() => {
    const conversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;
    const isNewConversation = conversationId === 'new';
    const hasArtifacts = artifacts && Object.keys(artifacts).length > 0;

    console.log('🎨 [Presentation] Rendering artifacts element:', {
      conversationId,
      isNewConversation,
      artifactsVisibility,
      artifactsCount: Object.keys(artifacts ?? {}).length,
      artifactKeys: Object.keys(artifacts ?? {}),
      hasArtifacts,
      willRender: artifactsVisibility === true && hasArtifacts,
    });

    // SAFETY: Only show panel if visibility is true AND there are actual artifacts
    if (artifactsVisibility === true && hasArtifacts) {
      return (
        <ArtifactsProvider>
          <EditorProvider>
            <Artifacts />
          </EditorProvider>
        </ArtifactsProvider>
      );
    }
    return null;
  }, [artifactsVisibility, artifacts, location.pathname]);

  /**
   * Memoize artifacts JSX to prevent recreating it on every render
   * This is critical for performance - prevents entire artifact tree from re-rendering
   * CRITICAL FIX: Removed length check - always render if visibility is true
   * This allows artifacts to load from localStorage even if state is initially empty
   *
   * IMPORTANT: For new conversations (/c/new), never show artifacts
   * even if visibility state hasn't been reset yet
   *
   * SAFETY CHECK: Only render if there are actual artifacts to display
   */
  const artifactsElement = useMemo(() => {
    const conversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;
    const isNewConversation = conversationId === 'new';
    const hasArtifacts = artifacts && Object.keys(artifacts).length > 0;

    console.log('🎨 [Presentation] Rendering artifacts element:', {
      conversationId,
      isNewConversation,
      artifactsVisibility,
      artifactsCount: Object.keys(artifacts ?? {}).length,
      artifactKeys: Object.keys(artifacts ?? {}),
      hasArtifacts,
      willRender: artifactsVisibility === true && hasArtifacts,
    });

    // SAFETY: Only show panel if visibility is true AND there are actual artifacts
    if (artifactsVisibility === true && hasArtifacts) {
      return (
        <ArtifactsProvider>
          <EditorProvider>
            <Artifacts />
          </EditorProvider>
        </ArtifactsProvider>
      );
    }
    return null;
  }, [artifactsVisibility, artifacts, location.pathname]);

  return (
    <DragDropWrapper className="relative flex w-full grow overflow-hidden bg-presentation">
      <SidePanelProvider>
        <SidePanelGroup
          defaultLayout={defaultLayout}
          fullPanelCollapse={fullCollapse}
          defaultCollapsed={defaultCollapsed}
          artifacts={artifactsElement}
        >
          <main className="flex h-full flex-col overflow-y-auto" role="main">
            {children}
          </main>
        </SidePanelGroup>
      </SidePanelProvider>
    </DragDropWrapper>
  );
}
