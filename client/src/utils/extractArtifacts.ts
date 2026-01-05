/**
 * Extracts artifact and artifactupdate blocks from a message text.
 * Handles multiline content, flexible attribute order, and intelligent merging.
 * When artifactupdate blocks are found, they are merged with existing artifacts.
 */

/**
 * Cleans artifact content by removing backticks and extra quotes
 */
function cleanArtifactContent(content: string): string {
  let cleaned = content.trim();

  // Remove opening and closing triple backticks (```language or just ```)
  // This handles: ```javascript\n...code...\n``` or ```\n...code...\n```
  cleaned = cleaned.replace(/^```[\w]*\s*\n?/, '').replace(/\n?```\s*$/, '');

  // Remove triple single quotes if they exist (''')
  cleaned = cleaned.replace(/^'''\s*\n?/, '').replace(/\n?'''\s*$/, '');

  // Remove extra surrounding quotes that might have been added
  // Only if they appear at the very start and end
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  return cleaned.trim();
}

export function extractAllArtifactsFromMessage(messageText: string, messageId?: string) {
  if (!messageText) {
    // console.log('⚠️ [extractArtifacts] No message text provided');
    return [];
  }

  // console.log('🔍 [extractArtifacts] Processing message text length:', messageText.length);

  // Regex to match both :::artifact and :::artifactupdate blocks
  const blockRegex = /:::(artifact(?:update)?)\s*\{([^}]*)\}:::\s*([\s\S]*?)\s*:::/g;

  const artifactMap = new Map<string, any>(); // Use Map to track by identifier
  let match;
  let matchCount = 0;

  while ((match = blockRegex.exec(messageText)) !== null) {
    matchCount++;
    const [, type, attrString, content] = match;

    // Parse attributes (key="value" or key='value' pairs) - handle both single and double quotes
    const attrRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;
    const attributes: Record<string, string> = {};
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
      const key = attrMatch[1];
      const value = attrMatch[2] || attrMatch[3] || attrMatch[4] || '';
      attributes[key] = value;
    }

    // console.log('🔧 [extractArtifacts] Parsed attributes:', attributes);

    // Ensure we have required attributes
    if (!attributes.identifier || !attributes.title || !attributes.type) {
      // console.log('⚠️ [extractArtifacts] Missing required attributes, using defaults');
      attributes.identifier = attributes.identifier || `artifact-${matchCount}`;
      attributes.title = attributes.title || `Untitled Artifact ${matchCount}`;
      attributes.type = attributes.type || type || 'code';
    }

    const isUpdate = type === 'artifactupdate';
    const identifier = attributes.identifier;

    // Clean the content to remove any wrapping backticks or quotes
    const cleanedContent = cleanArtifactContent(content);

    console.log('🧹 [extractArtifacts] Cleaned content:', {
      originalLength: content.length,
      cleanedLength: cleanedContent.length,
      removedChars: content.length - cleanedContent.length,
      cleanedPreview: cleanedContent.substring(0, 100),
    });

    if (isUpdate) {
      const timestamp = Date.now();

      // Find the original artifact (base artifact)
      const originalArtifact = artifactMap.get(identifier);

      if (!originalArtifact) {
        console.log(
          '⚠️ [extractArtifacts] artifactupdate found but no original artifact exists, treating as new artifact',
        );

        // Create new artifact from update
        const id = [identifier, 'artifact', attributes.title, messageId || '']
          .join('_')
          .replace(/\s+/g, '_')
          .replace(/[()]/g, '')
          .toLowerCase();

        const newArtifact = {
          id,
          identifier,
          title: attributes.title,
          type: attributes.type,
          content: cleanedContent,
          messageId,
          index: matchCount - 1,
          lastUpdateTime: Date.now(),
          isUpdate: false,
          ...attributes,
        };

        artifactMap.set(identifier, newArtifact);
        continue; // Skip to next iteration
      }

      //console.log('🔄 [extractArtifacts] Processing artifactupdate for:', identifier);

      // Create unique identifier for the update artifact
      const updatedIdentifier = `${originalArtifact.identifier}_${originalArtifact.type}_${originalArtifact.title}_${messageId}`;

      // CRITICAL: Check if this update already exists (streaming scenario)
      const existingUpdate = artifactMap.get(updatedIdentifier);

      if (existingUpdate) {
        // console.log(
        //   '🔄 [extractArtifacts] Streaming update - REPLACING existing update artifact:',
        //   {
        //     identifier: updatedIdentifier,
        //     oldContentLength: existingUpdate.content?.length || 0,
        //     newContentLength: cleanedContent.length,
        //     messageId,
        //   },
        // );

        // During streaming, merge the new chunk with the ORIGINAL base artifact
        // NOT with the previous update - this ensures we always show base + latest update
        const mergedContent = applyIntelligentMerge(originalArtifact.content, cleanedContent);

        const updatedArtifact = {
          ...existingUpdate,
          content: mergedContent, // MERGE with base, don't just use snippet
          lastUpdateTime: timestamp,
        };

        artifactMap.set(updatedIdentifier, updatedArtifact);
      } else {
        // console.log('✨ [extractArtifacts] First update - Creating new update artifact:', {
        //   identifier: updatedIdentifier,
        //   contentLength: cleanedContent.length,
        // });

        // First time seeing this update - merge with original
        const mergedContent = applyIntelligentMerge(originalArtifact.content, cleanedContent);
        const updatedTitle = `${originalArtifact.title}`;

        const updatedId = [updatedIdentifier, 'artifact', updatedTitle, messageId || '']
          .join('_')
          .replace(/\s+/g, '_')
          .replace(/[()]/g, '')
          .toLowerCase();

        const updatedArtifact = {
          id: updatedId,
          identifier: updatedIdentifier,
          title: updatedTitle,
          type: originalArtifact.type,
          content: mergedContent,
          messageId,
          index: originalArtifact.index,
          lastUpdateTime: timestamp,
          isUpdate: true,
          originalIdentifier: identifier,
          parentArtifactId: originalArtifact.id,
          ...attributes,
        };

        artifactMap.set(updatedIdentifier, updatedArtifact);
      }
    } else {
      // This is an original artifact block
      const id = [identifier, 'artifact', attributes.title, messageId || '']
        .join('_')
        .replace(/\s+/g, '_')
        .replace(/[()]/g, '')
        .toLowerCase();

      const artifact = {
        id,
        identifier,
        title: attributes.title,
        type: attributes.type,
        content: cleanedContent,
        messageId,
        index: matchCount - 1,
        lastUpdateTime: Date.now(),
        isUpdate: false,
        ...attributes,
      };

      artifactMap.set(identifier, artifact);
    }
  }

  const artifacts = Array.from(artifactMap.values());
  console.log(`🎯 [extractArtifacts] Total artifacts extracted: ${artifacts.length}`);

  // CRITICAL: Log each artifact's content preview to detect duplication
  artifacts.forEach((art, idx) => {
    const contentLines = art.content?.split('\n') || [];
    const hasDuplication =
      contentLines.filter((line, i, arr) => arr.filter((l) => l === line).length > 3).length > 0;

    console.log(`📄 [extractArtifacts] Artifact ${idx}:`, {
      id: art.id,
      identifier: art.identifier,
      contentLength: art.content?.length || 0,
      contentLines: contentLines.length,
      hasDuplication,
      contentPreview: art.content?.substring(0, 500),
    });
  });

  return artifacts;
}

/**
 * Apply intelligent merging of update content with original content
 */
function applyIntelligentMerge(
  originalContent: string,
  updateContent: string,
  selection?: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
    originalText: string;
  },
): string {
  console.log('🔀 [extractArtifacts] Applying intelligent merge');

  const updateLines = updateContent.split('\n');
  const originalLines = originalContent.split('\n');

  // If selection info is provided, use it to splice the update into the original
  if (
    selection &&
    typeof selection.startLine === 'number' &&
    typeof selection.startColumn === 'number'
  ) {
    const { startLine, endLine, startColumn, endColumn } = selection;
    const before = originalLines.slice(0, startLine);
    const after = originalLines.slice(endLine + 1);
    const targetLine = originalLines[startLine] || '';
    // Replace the target text in the target line
    const newLine = targetLine.slice(0, startColumn) + updateContent + targetLine.slice(endColumn);
    const merged = [...before, newLine, ...after].join('\n');
    console.log('✅ [extractArtifacts] Merged using selection info at line', startLine);
    return merged;
  }

  // Strategy: Replace matching sections in the original with the update
  // Find where the update content appears in the original
  let bestMatchIndex = -1;
  let bestMatchScore = 0;

  // Look for the first few lines of update in the original
  const searchLines = updateLines.slice(0, Math.min(3, updateLines.length));

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let score = 0;
    for (let j = 0; j < searchLines.length; j++) {
      const origLine = originalLines[i + j]?.trim() || '';
      const updateLine = searchLines[j]?.trim() || '';

      // Check if lines match (either exactly or partially)
      if (origLine === updateLine) {
        score += 2; // Exact match
      } else if (origLine.includes(updateLine) || updateLine.includes(origLine)) {
        score += 1; // Partial match
      }
    }

    if (score > bestMatchScore) {
      bestMatchScore = score;
      bestMatchIndex = i;
    }
  }

  // If we found a good match location (score >= 2), replace that section
  if (bestMatchIndex >= 0 && bestMatchScore >= 2) {
    const before = originalLines.slice(0, bestMatchIndex);
    const after = originalLines.slice(bestMatchIndex + updateLines.length);
    const merged = [...before, ...updateLines, ...after].join('\n');

    console.log('✅ [extractArtifacts] Smart merge - replaced section at line', bestMatchIndex);
    return merged;
  }

  // Fallback: If no good match and no selection, append the update with a warning
  console.warn('⚠️ [extractArtifacts] No match found - APPENDING update fragment to original');
  return originalContent + '\n\n// [ArtifactUpdate Fragment Appended]\n' + updateContent;
}
