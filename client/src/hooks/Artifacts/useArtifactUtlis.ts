import { artifactCache } from '~/components/Artifacts/ArtifactCache';

export async function ensureArtifactCacheHydrated(
  artifactId: string,
  artifactCacheInst = artifactCache,
) {
  console.log('load db for artifact', artifactId);
  await artifactCacheInst.initWithDatabase(artifactId);
  await artifactCacheInst._loadFromDatabase(artifactId);
}

export function applyPartialUpdate(
  originalContent: string,
  updateContent: string,
  artifactId: string,
  count: number,
  artifacts?: Record<string, any>,
): string {
  if (originalContent === updateContent) {
    console.log('No changes detected, skipping update.', artifactId);
    return originalContent;
  }
  console.log('artifactCacheInst', artifactCache);
  artifactId = artifactId.toLowerCase();
  console.log('applyPartialUpdate', updateContent, artifactId);
  const allSelectionValues = Array.from(artifactCache._selectionCache.values());
  const allSelectionEntries = Array.from(artifactCache._selectionCache.entries());
  //const selectionValuesDb = artifactCache._selectionCache.get(artifactId);

  // Strategy 1: Try cached selection context for this artifact first
  let cachedSelection = artifactCache.getSelection(artifactId);
  console.log('cachedSelection from artifactId', cachedSelection, allSelectionEntries.length);
  // Strategy 2: If this is an updated artifact, check the parent/original artifact
  if (!cachedSelection && allSelectionEntries.length > 0) {
    console.log('🔍 Strategy 2: Searching for selection by fileKey match:', {
      targetArtifactId: artifactId,
      totalEntries: allSelectionEntries.length,
      allFileKeys: allSelectionEntries.map(([key, details]) => ({
        cacheKey: key,
        fileKey: details.fileKey,
        fileKeyLower: details.fileKey.toLowerCase(),
        matches: details.fileKey.toLowerCase() === artifactId,
      })),
    });

    const selectionEntryValue = allSelectionEntries.find(
      ([key]) => key.replace(/\s+/g, '_').toLowerCase() === artifactId,
    );

    console.log('selectionEntryValue result:', {
      found: !!selectionEntryValue,
      entry: selectionEntryValue,
      cacheKey: selectionEntryValue?.[0],
      details: selectionEntryValue?.[1],
    });

    if (selectionEntryValue) {
      cachedSelection = selectionEntryValue[1];
      console.log('✅ Found cachedSelection from parent/original artifact:', {
        artifactId: cachedSelection.artifactId,
        fileKey: cachedSelection.fileKey,
        startLine: cachedSelection.startLine,
        endLine: cachedSelection.endLine,
        hasOriginalText: !!cachedSelection.originalText,
        originalTextPreview: cachedSelection.originalText?.substring(0, 50),
      });
    }
  }

  // Strategy 3: Search all selection values
  if (!cachedSelection && allSelectionValues) {
    console.log('strategy 3');
    console.log('updateContent.trim().replace', updateContent.trim().replace(/\n+$/, ''));
    console.log('No cached selection found, searching allSelectionValues...');
    // Try to find a selection context in allSelectionValues for this artifactId
    cachedSelection = allSelectionValues.find((cache) => cache.artifactId === artifactId);
    if (!cachedSelection && allSelectionValues) {
      cachedSelection = allSelectionValues[count];
    }
  }

  // Strategy 4: Try previous artifact as fallback
  if (!cachedSelection && artifacts) {
    console.log('strategy 4');
    const artifactArray = Object.values(artifacts);
    const sortedArtifacts = artifactArray
      .filter((a) => a.id !== artifactId)
      .sort((a, b) => b.lastUpdateTime - a.lastUpdateTime);
    const previousArtifact = sortedArtifacts[0];
    const previousArtifactId = previousArtifact ? previousArtifact.id : null;
    console.log('previousArtifactId', previousArtifactId);
    cachedSelection = artifactCache.getSelection(previousArtifactId);
  }
  // If no valid selection context, skip merging to avoid duplication
  if (
    !cachedSelection ||
    typeof cachedSelection.startLine !== 'number' ||
    typeof cachedSelection.endLine !== 'number' ||
    typeof cachedSelection.startColumn !== 'number' ||
    typeof cachedSelection.endColumn !== 'number'
  ) {
    console.warn(
      'No valid selection context found for partial update. Skipping merge for artifact:',
      artifactId,
    );
    return originalContent;
  }

  // --- Precise merging using line and column ---
  const startLine = cachedSelection.startLine;
  const endLine = cachedSelection.endLine;
  const startColumn = cachedSelection.startColumn;
  const endColumn = cachedSelection.endColumn;
  const lines = originalContent.split('\n');
  if (typeof updateContent === 'undefined') return originalContent;
  const updateLines = updateContent.split('\n');

  if (startLine === endLine) {
    // Single-line selection: replace only the substring
    const line = lines[startLine] || '';
    const before = line.slice(0, startColumn);
    const after = line.slice(endColumn);
    lines[startLine] = before + updateContent + after;
    return lines.join('\n');
  } else {
    // Multi-line selection: replace partial start/end lines and all lines in between
    const beforeStart = lines[startLine]?.slice(0, startColumn) || '';
    const afterEnd = lines[endLine]?.slice(endColumn) || '';
    const before = lines.slice(0, startLine);
    const after = lines.slice(endLine + 1);
    let mergedUpdateLines: string[] = [];
    // console.log("updateLines", updateLines);
    // console.log("beforeStart", beforeStart, "afterEnd", afterEnd);
    if (updateLines.length === 1) {
      // Single update line replaces the whole region
      mergedUpdateLines = [beforeStart + updateLines[0] + afterEnd];
    } else if (updateLines.length === 2) {
      // Two lines: first line gets prefix, second gets suffix
      mergedUpdateLines = [beforeStart + updateLines[0], updateLines[1] + afterEnd];
    } else {
      // More than two lines: first line gets prefix, last gets suffix, middle lines as-is
      mergedUpdateLines = [
        beforeStart + updateLines[0],
        ...updateLines.slice(1, -1),
        updateLines[updateLines.length - 1] + afterEnd,
      ];
    }
    const mergedContent = [...before, ...mergedUpdateLines, ...after].join('\n');
    return mergedContent;
  }
}

export function applyAllPartialUpdates(
  originalContent: string,
  artifacts: Record<string, any> | null,
  targetArtifactId?: string,
) {
  console.log('applyAllPartialUpdates function', artifacts, 'targetArtifactId:', targetArtifactId);
  if (!artifacts) return originalContent;
  const targetArtifact = targetArtifactId ? artifacts[targetArtifactId] : null;
  const targetTime = targetArtifact?.lastUpdateTime || Infinity;

  console.log('🎯 Target artifact info:', {
    targetArtifactId,
    targetTime,
    targetArtifact: targetArtifact,
  });

  // Start with the original base content, then apply each update sequentially
  let mergedContent = originalContent;
  const updateArtifacts = Object.values(artifacts)
    .filter((a: any) => {
      // CRITICAL: Only process artifacts that are marked as updates
      const _isUpdate = a && a.isUpdate === true;
      const _isWithinTimeRange =
        !targetArtifactId || (a.lastUpdateTime && a.lastUpdateTime <= targetTime);

      console.log('🔍 Checking artifact for update:', {
        identifier: a?.identifier,
        isUpdate: _isUpdate,
        isMarkedAsUpdate: a?.isUpdate,
        isWithinTimeRange: _isWithinTimeRange,
        artifactTime: a?.lastUpdateTime,
        targetTime,
        hasContent: !!a?.content,
        contentLength: a?.content?.length,
      });

      return _isUpdate && _isWithinTimeRange;
    })
    .sort((a: any, b: any) => (a.lastUpdateTime || 0) - (b.lastUpdateTime || 0));
  let count = 0;
  console.log('updateArrifacts', updateArtifacts);
  for (const updateArtifact of updateArtifacts) {
    console.log(
      'count update',
      count,
      'artifact:',
      updateArtifact.id,
      'content:',
      updateArtifact.content,
    );
    // CRITICAL FIX: Apply each update to the previous merged result
    // This allows updates to build sequentially on top of each other
    console.log('🔧 Applying update to MERGED content (previous result)');
    const newContent = applyPartialUpdate(
      mergedContent,
      updateArtifact.content,
      updateArtifact.id,
      count,
      updateArtifacts,
    );
    console.log('📦 Update result preview:', newContent.substring(0, 200));
    // Only update if content actually changed
    if (newContent !== mergedContent) {
      console.log('✅ Content changed, updating mergedContent');
      mergedContent = newContent;
      artifactCache.setContent(updateArtifact.id, mergedContent);
    } else {
      console.log('⏭️  Content unchanged, skipping');
    }
    count++;
  }
  return mergedContent;
}
