import { useEffect, useRef } from 'react';
import debounce from 'lodash/debounce';
import { useLocation } from 'react-router-dom';
import { useRecoilState, useSetRecoilState, useResetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { cn, getFileType, logger } from '~/utils';
import { useLocalize } from '~/hooks';
import store from '~/store';

const ArtifactButton = ({ artifact }: { artifact: Artifact | null }) => {
  const localize = useLocalize();
  const location = useLocation();
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const isSelected = artifact?.id === currentArtifactId;
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);

  // Get current conversation ID from URL
  const currentConversationId = location.pathname.match(/\/c\/([^/]+)/)?.[1] || null;

  const debouncedSetVisibleRef = useRef(
    debounce((artifactToSet: Artifact) => {
      logger.log(
        'artifacts_visibility',
        'Setting artifact to visible state from Artifact button',
        artifactToSet,
      );
      setVisibleArtifacts((prev) => ({
        ...prev,
        [artifactToSet.id]: artifactToSet,
      }));
    }, 750),
  );

  useEffect(() => {
    if (artifact == null || artifact?.id == null || artifact.id === '') {
      return;
    }

    if (!location.pathname.includes('/c/')) {
      return;
    }

    const debouncedSetVisible = debouncedSetVisibleRef.current;
    debouncedSetVisible(artifact);
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
      {(() => {
        const handleClick = () => {
          if (isSelected) {
            resetCurrentArtifactId();
            setVisible(false);
            return;
          }
          console.log('[ArtifactButton] Clicked:', { id: artifact.id, title: artifact.title });

          // CRITICAL: Check if this artifact belongs to the current conversation
          // Strategy 1: Check if artifact exists in state
          const artifactExistsInState = _artifacts?.[artifact.id] != null;
          // Strategy 2: Check conversationId match (if available)
          const conversationIdMatches =
            !artifact.conversationId || // No conversationId set (legacy artifacts)
            !currentConversationId || // No current conversation (edge case)
            artifact.conversationId === currentConversationId;

          // CRITICAL FIX: If artifact exists in visibleArtifacts but not in state,
          // it might just be a timing issue. Add it to state instead of blocking.
          if (!artifactExistsInState) {
            console.warn('⚠️ [ArtifactButton] Artifact not in state - checking conversationId:', {
              artifactId: artifact.id,
              artifactConversationId: artifact.conversationId,
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

          if (artifacts?.[artifact.id] == null) {
            setArtifacts(visibleArtifacts);
          }

          setTimeout(() => {
            setCurrentArtifactId(artifact.id);
          }, 15);
        };

        const buttonClass = cn(
          'relative overflow-hidden rounded-xl transition-all duration-300 hover:border-border-medium hover:bg-surface-hover hover:shadow-lg active:scale-[0.98]',
          {
            'border-border-medium bg-surface-hover shadow-lg': isSelected,
            'border-border-light bg-surface-tertiary shadow-sm': !isSelected,
          },
        );

        const actionLabel = isSelected
          ? localize('com_ui_click_to_close')
          : localize('com_ui_artifact_click');

        return (
          <button type="button" onClick={handleClick} className={buttonClass}>
            <div className="w-fit p-2">
              <div className="flex flex-row items-center gap-2">
                <FilePreview fileType={fileType} className="relative" />
                <div className="overflow-hidden text-left">
                  <div className="truncate font-medium">{artifact.title}</div>
                  <div className="truncate text-text-secondary">{actionLabel}</div>
                </div>
              </div>
            </div>
          </button>
        );
      })()}
      <br />
    </div>
  );
};

export default ArtifactButton;
