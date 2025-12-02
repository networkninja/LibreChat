/**
 * Extracts artifact and artifactupdate blocks from a message text.
 * Handles multiline content, flexible attribute order, and intelligent merging.
 * When artifactupdate blocks are found, they are merged with existing artifacts.
 */
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

    if (isUpdate) {
      // This is an update block - merge with existing artifact
      const existingArtifact = artifactMap.get(identifier);

      if (existingArtifact) {
        // console.log(
        //   '🔄 [extractArtifacts] Merging artifactupdate with existing artifact:',
        //   identifier,
        // );

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

        console.log('✅ [extractArtifacts] Updated artifact content:', {
          identifier,
          originalLength: existingArtifact.content.length - content.trim().length,
          updateLength: content.trim().length,
          mergedLength: mergedContent.length,
        });
      } else {
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
          content: content.trim(),
          messageId,
          index: matchCount - 1,
          lastUpdateTime: Date.now(),
          isUpdate: false,
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

  // For artifactupdate, simply replace the entire content
  // This prevents duplication issues when updating HTML/code artifacts
  console.log('✅ [extractArtifacts] Replacing entire artifact content with update');
  return updateContent;
}
