import { useEffect, useRef } from 'react';
import debounce from 'lodash/debounce';
import { useLocation } from 'react-router-dom';
import { useRecoilState, useSetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { getFileType } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

const ArtifactButton = ({ artifact }: { artifact: Artifact | null }) => {
  const localize = useLocalize();
  const location = useLocation();
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const [_artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);

  // Get current conversation ID from URL
  const currentConversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;

  const debouncedSetVisibleRef = useRef(
    debounce(
      (artifactToSet: Artifact, currentVisible: Record<string, Artifact | undefined> | null) => {
        // Guard: Only update if the artifact is not already visible or has changed
        console.log("existingArtifact:", currentVisible, artifactToSet);
        if (currentVisible) {
          const existingArtifact = currentVisible[artifactToSet.id];
          console.log(
            'existingArtifact content:',
            existingArtifact?.content,
            artifactToSet.content,
          );
          // if (existingArtifact && existingArtifact.content === artifactToSet.content) {
          //   console.log(
          //     'artifacts_visibility',
          //     'Skipping update - artifact already visible with same content',
          //     artifactToSet.id,
          //   );
          //   return;
          // }
        }

        console.log(
          'artifacts_visibility',
          'Setting artifact to visible state from Artifact button',
          artifactToSet,
        );
        setVisibleArtifacts((prev) => ({
          ...prev,
          [artifactToSet.id]: artifactToSet,
        }));
      },
      100,
    ),
  );

  useEffect(() => {
    if (artifact == null || artifact?.id == null || artifact.id === '') {
      return;
    }

    if (!location.pathname.includes('/c/')) {
      return;
    }

    const debouncedSetVisible = debouncedSetVisibleRef.current;
    debouncedSetVisible(artifact, visibleArtifacts);
    return () => {
      debouncedSetVisible.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact?.id, artifact?.content, location.pathname]);

  if (artifact === null || artifact === undefined) {
    return null;
  }
  const fileType = getFileType('artifact');

  return (
    <div className="group relative my-4 rounded-xl text-sm text-text-primary">
      <button
        type="button"
        onClick={() => {
          if (!location.pathname.includes('/c/')) {
            return;
          }
          console.log('[ArtifactButton] Clicked:', { id: artifact.id, title: artifact.title });

          // CRITICAL: Check if this artifact belongs to the current conversation
          // Artifacts are stored per-conversation, so clicking artifacts from other chats won't work
          const artifactExistsInCurrentConversation = _artifacts?.[artifact.id] != null;

          if (!artifactExistsInCurrentConversation) {
            console.warn('⚠️ [ArtifactButton] Artifact does not belong to current conversation:', {
              artifactId: artifact.id,
              currentConversationId,
              artifactInState: !!_artifacts?.[artifact.id],
              message:
                'This artifact belongs to a different conversation. Switch to that conversation to view it.',
            });
            // Don't open the artifact - it's not in the current conversation's state
            return;
          }

          setCurrentArtifactId(artifact.id);
          setVisible(true);

          if (_artifacts?.[artifact.id] == null) {
            console.warn('🚨 [ArtifactButton] Artifact not in artifacts state:', artifact.id);
            console.warn(
              '⚠️ [ArtifactButton] NOT copying visibleArtifacts to prevent contamination',
            );

            // SAFER: Only add THIS specific artifact, not all visibleArtifacts
            // Check if it's a base artifact (not an update) before adding
            if (!artifact.isUpdate) {
              console.log('✅ [ArtifactButton] Adding BASE artifact to state:', artifact.id);
              setArtifacts((prev) => ({
                ...prev,
                [artifact.id]: artifact,
              }));
            } else {
              console.warn(
                '⚠️ [ArtifactButton] Skipping UPDATE artifact - should already be in state:',
                artifact.id,
              );
            }
          }

          setTimeout(() => {
            setCurrentArtifactId(artifact.id);
          }, 15);
        }}
        className="relative overflow-hidden rounded-xl border border-border-medium transition-all duration-300 hover:border-border-xheavy hover:shadow-lg"
      >
        <div className="w-fit bg-surface-tertiary p-2">
          <div className="flex flex-row items-center gap-2">
            <FilePreview fileType={fileType} className="relative" />
            <div className="overflow-hidden text-left">
              <div className="truncate font-medium">{artifact.title}</div>
              <div className="truncate text-text-secondary">
                {localize('com_ui_artifact_click')}
              </div>
            </div>
          </div>
        </div>
      </button>
      <br />
    </div>
  );
};

export default ArtifactButton;
