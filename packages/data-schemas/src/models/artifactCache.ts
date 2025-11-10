import artifactCacheSchema from '~/schema/artifactCache';
import type { IArtifactCache } from '~/types';

export function createArtifactCacheModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.ArtifactCache ||
    mongoose.model<IArtifactCache>('ArtifactCache', artifactCacheSchema)
  );
}
