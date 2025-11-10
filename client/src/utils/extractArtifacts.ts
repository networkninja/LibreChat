/**
 * Extracts artifact and artifactupdate blocks from a message text.
 * Handles multiline content, flexible attribute order, and intelligent merging.
 * When artifactupdate blocks are found, they are merged with existing artifacts.
 */
export function extractAllArtifactsFromMessage(messageText: string, messageId?: string) {
  if (!messageText) {
    console.log('⚠️ [extractArtifacts] No message text provided');
    return [];
  }

  console.log('🔍 [extractArtifacts] Processing message text length:', messageText.length);

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

    console.log('🔧 [extractArtifacts] Parsed attributes:', attributes);

    // Ensure we have required attributes
    if (!attributes.identifier || !attributes.title || !attributes.type) {
      console.log('⚠️ [extractArtifacts] Missing required attributes, using defaults');
      attributes.identifier = attributes.identifier || `artifact-${matchCount}`;
      attributes.title = attributes.title || `Untitled Artifact ${matchCount}`;
      attributes.type = attributes.type || type || 'code';
    }

    const isUpdate = type === 'artifactupdate';
    const identifier = attributes.identifier;

    if (isUpdate) {
      // This is an update block - merge with existing artifact
      const existingArtifact = artifactMap.get(identifier);

      if (existingArtifact) {
        console.log(
          '🔄 [extractArtifacts] Merging artifactupdate with existing artifact:',
          identifier,
        );

        // Apply intelligent merging
        const mergedContent = applyIntelligentMerge(existingArtifact.content, content.trim());

        // Create a separate updated artifact with unique identifier
        // Use timestamp to ensure uniqueness and ordering
        const timestamp = Date.now();
        const updatedIdentifier = `${existingArtifact.identifier}_${existingArtifact.type}_${existingArtifact.title}_${messageId}`;
        const updatedTitle = `${existingArtifact.title}`;

        const updatedId = [updatedIdentifier, 'artifact', updatedTitle, messageId || '']
          .join('_')
          .replace(/\s+/g, '_')
          .replace(/[()]/g, '')
          .toLowerCase();

        const updatedArtifact = {
          id: updatedId,
          identifier: updatedIdentifier,
          title: updatedTitle,
          type: existingArtifact.type,
          content: mergedContent,
          messageId,
          index: existingArtifact.index, // Keep same index as original to maintain position
          lastUpdateTime: timestamp,
          isUpdate: true,
          originalIdentifier: identifier, // Track the original artifact
          parentArtifactId: existingArtifact.id, // Track immediate parent for chaining
          ...attributes,
        };

        // Add the updated artifact to the map (keeps both original and updated)
        artifactMap.set(updatedIdentifier, updatedArtifact);
      } else {
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
          content: content.trim(),
          messageId,
          index: matchCount - 1,
          lastUpdateTime: Date.now(),
          isUpdate: true,
          ...attributes,
        };

        artifactMap.set(identifier, newArtifact);
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
        content: content.trim(),
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
  return artifacts;
}

/**
 * Apply intelligent merging of update content with original content
 */
function applyIntelligentMerge(originalContent: string, updateContent: string): string {
  console.log('🔀 [extractArtifacts] Applying intelligent merge');

  // Simple strategy: if update content is significantly smaller, it might be a focused change
  const originalLines = originalContent.split('\n');
  const updateLines = updateContent.split('\n');

  // If update is much smaller than original, try to find best insertion point
  if (updateLines.length < originalLines.length * 0.8) {
    console.log('📝 [extractArtifacts] Small update detected, using smart insertion');

    // Find the best match point by looking for similar content
    let bestMatch = -1;
    let bestScore = 0;

    for (let i = 0; i <= originalLines.length - updateLines.length; i++) {
      let score = 0;
      for (let j = 0; j < Math.min(3, updateLines.length); j++) {
        if (i + j < originalLines.length) {
          const similarity = calculateSimilarity(
            originalLines[i + j].trim(),
            updateLines[j].trim(),
          );
          score += similarity;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = i;
      }
    }

    // If we found a good match (similarity > 0.6), replace that section
    if (bestMatch >= 0 && bestScore > 0.6) {
      const before = originalLines.slice(0, bestMatch);
      const after = originalLines.slice(bestMatch + updateLines.length);
      const merged = [...before, ...updateLines, ...after].join('\n');

      console.log(
        '🧠 [extractArtifacts] Smart merge applied at line',
        bestMatch,
        'with score',
        bestScore,
      );
      return merged;
    }
  }

  // Fallback: append the update content
  console.log('📄 [extractArtifacts] Using append strategy');
  return originalContent + '\n\n' + updateContent;
}

/**
 * Calculate similarity between two strings (0-1 score)
 */
function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1;

  // Simple character-based similarity
  const editDistance = calculateEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate edit distance between two strings using dynamic programming
 */
function calculateEditDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator, // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}
