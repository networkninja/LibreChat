import { artifactCache } from '~/components/Artifacts/ArtifactCache';

// --- Post-merge sanitizer: fixes common merge artifacts like malformed attributes ---
function _sanitizeMergeResult(content: string): string {
  if (!content) return content;

  let fixed = content;

  const malformedClassNamePattern = /(className\s*=\s*"[^"]*")>"[^"]*">/g;
  if (malformedClassNamePattern.test(fixed)) {
    console.warn('🧹 [SANITIZE] Detected malformed className - fixing...');
    fixed = fixed.replace(malformedClassNamePattern, (_match, capture) => {
      console.log('  Fixed:', _match, '→', capture + '>');
      return capture + '>';
    });
  }

  const malformedStylePattern = /(style\s*=\s*"[^"]*")>"[^"]*">/g;
  if (malformedStylePattern.test(fixed)) {
    console.warn('🧹 [SANITIZE] Detected malformed style - fixing...');
    fixed = fixed.replace(malformedStylePattern, (_match, capture) => {
      console.log('  Fixed:', _match, '→', capture + '>');
      return capture + '>';
    });
  }

  const malformedIdPattern = /((id|data-[a-z-]+)\s*=\s*"[^"]*")>"[^"]*">/g;
  if (malformedIdPattern.test(fixed)) {
    console.warn('🧹 [SANITIZE] Detected malformed id/data attribute - fixing...');
    fixed = fixed.replace(malformedIdPattern, (_match, capture) => {
      console.log('  Fixed:', _match, '→', capture + '>');
      return capture + '>';
    });
  }

  // Log if any fixes were applied
  if (fixed !== content) {
    console.log('✅ [SANITIZE] Applied merge artifact fixes:', {
      originalLength: content.length,
      fixedLength: fixed.length,
      charsDiff: fixed.length - content.length,
    });
  }

  return fixed;
}

// --- Sanitizer: removes duplicate closing tags, orphan style fragments, dangling tails, duplicated <p> blocks, and DUPLICATE DOCTYPE/HTML ---
function _sanitizeArtifactContent(html: string): string {
  if (!html) return html;
  let out = html;

  const doctypeMatches = out.match(/<!DOCTYPE[^>]*>/gi);
  if (doctypeMatches && doctypeMatches.length > 1) {
    console.log('🧹 [sanitize] Found duplicate DOCTYPE declarations:', doctypeMatches.length);
    // Keep only the first DOCTYPE, remove all others
    const firstDoctype = doctypeMatches[0];
    out = out.replace(/<!DOCTYPE[^>]*>/gi, ''); // Remove all
    out = firstDoctype + out; // Add first one back at the start
  }

  const htmlOpenMatches = out.match(/<html[^>]*>/gi);
  if (htmlOpenMatches && htmlOpenMatches.length > 1) {
    console.log('🧹 [sanitize] Found duplicate <html> opening tags:', htmlOpenMatches.length);
    let foundFirst = false;
    out = out.replace(/<html[^>]*>/gi, (match) => {
      if (!foundFirst) {
        foundFirst = true;
        return match; // Keep first
      }
      return ''; // Remove duplicates
    });
  }

  // Deduplicate closing tags
  out = out.replace(/<\/body>\s*<\/body>/gi, '</body>').replace(/<\/html>\s*<\/html>/gi, '</html>');

  const htmlCloseMatches = out.match(/<\/html>/gi);
  if (htmlCloseMatches && htmlCloseMatches.length > 1) {
    console.log('🧹 [sanitize] Found duplicate </html> closing tags:', htmlCloseMatches.length);
    // Remove all but the last one
    let count = 0;
    const totalMatches = htmlCloseMatches.length;
    out = out.replace(/<\/html>/gi, () => {
      count++;
      if (count < totalMatches) {
        return ''; // Remove all except last
      }
      return '</html>'; // Keep last one
    });
  }

  // Remove orphan attribute/style fragment lines (e.g., "yle=\"...")
  out = out
    .split('\n')
    .filter((l) => !/^\s*:?(y?le)="[^"]*$/.test(l.trim()))
    .filter((l) => !/^(y?le)="[^"]*/.test(l.trim()))
    .join('\n');

  // Cut off anything after final </html>
  const htmlCloseIdx = out.toLowerCase().lastIndexOf('</html>');
  if (htmlCloseIdx !== -1) {
    out = out.slice(0, htmlCloseIdx + 7);
  }

  // Deduplicate identical <p> lines inside body
  out = out.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i, (_, open, inner, close) => {
    const seen = new Set<string>();
    const cleaned = inner
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('<p')) return true;
        if (seen.has(trimmed)) return false;
        seen.add(trimmed);
        return true;
      })
      .join('\n');
    return open + cleaned + close;
  });

  return out;
}

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
  skipValidation?: boolean, // NEW: Skip validation when applying sequential updates
): string {
  // --- NEW HELPERS (dedupe & body replacement) ---
  const isFullDoc = (c: string) => /<!DOCTYPE|<html|<head>|<body>/i.test(c);
  const isSnippet = (c: string) => !isFullDoc(c) && /<p[ >]/i.test(c);
  const _normalizeSnippet = (c: string) => c.trim().replace(/\n{2,}/g, '\n');
  const _extractBody = (c: string) => {
    const start = c.search(/<body[^>]*>/i);
    const end = c.search(/<\/body>/i);
    if (start === -1 || end === -1) return null;
    const bodyTagClose = c.indexOf('>', start) + 1;
    return {
      prefix: c.slice(0, bodyTagClose),
      bodyContent: c.slice(bodyTagClose, end),
      suffix: c.slice(end),
    };
  };
  // --- END HELPERS ---
  artifactId = artifactId.toLowerCase();
  const baseIdentifier = artifactId.split('_update')[0];
  const isUpdateArtifact = artifactId.includes('_update');

  if (originalContent === updateContent) {
    console.log('No changes detected, skipping update.', artifactId);
    return originalContent;
  }
  // QUICK full replacement short-circuit
  const updateRatio = updateContent.length / (originalContent.length || 1);
  console.log('📊 Update size ratio:', { updateRatio });

  // SPECIAL CASE: Original is full doc, incoming is a snippet
  // Check if we have selection context - if yes, use it for precise placement
  // If no, STRICT MODE: return original (don't append without selection!)
  if (isFullDoc(originalContent) && isSnippet(updateContent)) {

    // STRATEGY: Try to find selection context first for precise placement
    const selectionContext =
      artifactCache.getSelection(artifactId) || artifactCache.getSelection(baseIdentifier);

    if (
      selectionContext &&
      typeof selectionContext.startLine === 'number' &&
      typeof selectionContext.endLine === 'number' &&
      typeof selectionContext.startColumn === 'number' &&
      typeof selectionContext.endColumn === 'number'
    ) {
      console.log('✅ [Snippet Update] Found selection context - using precise placement:', {
        startLine: selectionContext.startLine,
        endLine: selectionContext.endLine,
        startColumn: selectionContext.startColumn,
        endColumn: selectionContext.endColumn,
      });

      // Use the precise line/column placement logic below
      // DON'T return here - let it fall through to the line-based merging
    } else {
      return originalContent; // STRICT MODE: Don't append without selection!
    }
  }

  // This prevents unwanted spaces when merging snippets into the artifact
  const trimmedUpdateContent = updateContent.trim();

  console.log('🔧 [applyPartialUpdate] Starting update:', {
    artifactId,
    originalContentLength: originalContent.length,
    updateContentLength: updateContent.length,
    updateContentLengthAfterTrim: trimmedUpdateContent.length,
    originalPreview: originalContent.substring(0, 100),
    updatePreview: updateContent.substring(0, 100),
    updatePreviewTrimmed: trimmedUpdateContent.substring(0, 100),
    trimmedChars: updateContent.length - trimmedUpdateContent.length,
  });

  // Use trimmed content for the rest of the function
  updateContent = trimmedUpdateContent;

  artifactId = artifactId.toLowerCase();

  if (artifactCache._selectionCache.size === 0) {

    // Try to load from database as a fallback (this is sync in the sense that we log it, but won't block)
    artifactCache._loadFromDatabase(artifactId).then(() => {
      console.log(
        '📥 [applyPartialUpdate] Emergency database load completed, cache size now:',
        artifactCache._selectionCache.size,
      );
    });
  }

  const allSelectionValues = Array.from(artifactCache._selectionCache.values());
  const allSelectionEntries = Array.from(artifactCache._selectionCache.entries());

  // Strategy 1: Try cached selection context for this artifact first
  let cachedSelection = artifactCache.getSelection(artifactId);
  console.log('artifactCache for selection', cachedSelection);
  const cachedSelectiontest = artifactCache._loadFromDatabase(artifactId);

  // Strategy 1.5: If this is an update artifact and no selection found, try the base identifier
  if (!cachedSelection && isUpdateArtifact && baseIdentifier) {
    cachedSelection = artifactCache.getSelection(baseIdentifier);
  }

  // Strategy 1.75: Search by identifier substring match (most flexible)
  // This handles cases where the selection key has a timestamp or other suffix
  if (!cachedSelection && (baseIdentifier || artifactId)) {
    const _searchIdentifier = baseIdentifier || artifactId.split('_update')[0];

    // Each update (update0, update1, update2...) should have its OWN selection context
    const updateIndexMatch = artifactId.match(/_update(\d+)_/);
    const updateIndex = updateIndexMatch ? parseInt(updateIndexMatch[1], 10) : null;

    // Fuzzy matching can cause update0's selection to be used for update1
    const exactMatch = allSelectionEntries.find(([key, _val]) => {
      return key.toLowerCase() === artifactId.toLowerCase();
    });

    if (exactMatch) {
      cachedSelection = exactMatch[1];

      const selectionUpdateIndex = (cachedSelection as any).updateIndex;
      const selectionArtifactId = (cachedSelection as any).artifactId;
      if (
        updateIndex !== null &&
        selectionUpdateIndex !== undefined &&
        updateIndex !== selectionUpdateIndex
      ) {
        console.error('🚨🚨🚨 [CRITICAL BUG DETECTED] Using selection from WRONG update!', {
          requestedUpdate: updateIndex,
          selectionFromUpdate: selectionUpdateIndex,
          requestedArtifactId: artifactId,
          selectionArtifactId,
          THIS_IS_THE_BUG: 'Selection cache returned coordinates from a different update',
          RESULT: 'Updates will replace content at SAME SPOT instead of their intended location',
        });
      }
    } else if (updateIndex !== null) {
      // Strategy 1.6: If exact match failed but this is an update artifact,
      // try searching for selections with the same base identifier but different update indices
      // This handles the case where the update index was calculated differently
      console.warn('⚠️ [applyPartialUpdate] No exact match - trying adjacent update indices', {
        requestedArtifactId: artifactId,
        requestedUpdateIndex: updateIndex,
        allAvailableKeys: allSelectionEntries.map(([key]) => key),
      });

      // Extract the base pattern (everything except the update index)
      const _basePattern = artifactId.replace(/_update\d+_/, '_update{N}_');

      // Try update indices from 0 to 10 (should cover most cases)
      for (let tryIndex = 0; tryIndex <= 10; tryIndex++) {
        if (tryIndex === updateIndex) continue; // Already tried exact match

        const tryArtifactId = artifactId.replace(/_update\d+_/, `_update${tryIndex}_`);
        console.log(`   🔍 Trying index ${tryIndex}: ${tryArtifactId}`);

        const tryMatch = allSelectionEntries.find(
          ([key, _val]) => key.toLowerCase() === tryArtifactId.toLowerCase(),
        );

        if (tryMatch) {
          cachedSelection = tryMatch[1];
          console.warn('⚠️✅ [applyPartialUpdate] FOUND selection with DIFFERENT update index!', {
            requestedArtifactId: artifactId,
            requestedUpdateIndex: updateIndex,
            foundArtifactId: tryMatch[0],
            foundUpdateIndex: tryIndex,
            WARNING: 'Update index mismatch - this indicates a race condition in update counting',
            selectionDetails: {
              startLine: cachedSelection.startLine,
              endLine: cachedSelection.endLine,
              startColumn: cachedSelection.startColumn,
              endColumn: cachedSelection.endColumn,
            },
          });
          break;
        }
      }

      // Strategy 1.7: If still not found, try FUZZY matching - match any selection with same base identifier
      if (!cachedSelection) {
        console.warn(
          '⚠️ [Strategy 1.7] Index fallback failed - trying FUZZY base identifier match',
        );

        const baseId = artifactId.split('_update')[0]; // e.g., "tiny-html"
        const fuzzyMatch = allSelectionEntries.find(([key, _val]) => {
          const keyBase = key.split('_update')[0];
          return keyBase.toLowerCase() === baseId.toLowerCase();
        });

        if (fuzzyMatch) {
          cachedSelection = fuzzyMatch[1];
          console.warn('⚠️✅ [Strategy 1.7] FOUND selection via FUZZY base match!', {
            requestedArtifactId: artifactId,
            foundArtifactId: fuzzyMatch[0],
            WARNING:
              'Using fuzzy match - this may apply to wrong location if multiple updates exist',
          });
        }
      }
    }
  }

  // Strategy 2: Search allSelectionEntries for any match
  if (!cachedSelection && allSelectionEntries.length > 0) {
    console.log('🔍 Strategy 2: Searching allSelectionEntries for match:', {
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

    if (selectionEntryValue) {
      cachedSelection = selectionEntryValue[1];
      console.log('✅ Found cachedSelection from allSelectionEntries:', {
        cacheKey: selectionEntryValue[0],
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
    console.log('No cached selection found, searching allSelectionValues...', allSelectionValues);
    // Try to find a selection context in allSelectionValues for this artifactId
    cachedSelection = allSelectionValues.find((cache) => cache.artifactId === artifactId);
  }

  // Strategy 4: Try previous artifact as fallback
  if (!cachedSelection && artifacts && !isUpdateArtifact) {
    // console.log(
    //   '🔍 [applyPartialUpdate] Strategy 4: Looking for previous artifact selection (NON-UPDATE artifacts only)',
    // );

    const artifactArray = Object.values(artifacts);

    // Sort artifacts by time (oldest to newest) to find the one that came just before this one
    const sortedArtifacts = artifactArray
      .filter((a) => a.id !== artifactId) // Exclude current artifact
      .sort((a, b) => a.lastUpdateTime - b.lastUpdateTime); // Oldest first

    console.log('📋 [Strategy 4] Sorted artifacts (oldest to newest):', {
      total: sortedArtifacts.length,
      artifacts: sortedArtifacts.map((a) => ({
        id: a.id,
        time: a.lastUpdateTime,
        isUpdate: a.isUpdate,
      })),
    });

    // Find the artifact that came just before the current one
    const currentArtifact = artifactArray.find((a) => a.id === artifactId);
    const currentTime = currentArtifact?.lastUpdateTime || 0;

    // Get all artifacts BEFORE this one (earlier timestamp)
    const previousArtifacts = sortedArtifacts
      .filter((a) => a.lastUpdateTime < currentTime)
      .sort((a, b) => b.lastUpdateTime - a.lastUpdateTime); // Most recent first

    const previousArtifact = previousArtifacts[0]; // The most recent one before current

    if (previousArtifact) {
      const previousArtifactId = previousArtifact.id;
      // Try to get selection from the previous artifact's ID
      cachedSelection = artifactCache.getSelection(previousArtifactId);

      console.log('📍 [Strategy 4] Selection lookup result:', {
        previousArtifactId,
        found: !!cachedSelection,
        selection: cachedSelection,
        startLine: cachedSelection?.startLine,
        endLine: cachedSelection?.endLine,
        originalTextPreview: cachedSelection?.originalText?.substring(0, 50),
      });
    } else {
      console.log('⚠️ [Strategy 4] No previous artifact found');
    }
  } else if (!cachedSelection && isUpdateArtifact) {
    console.warn(
      '⚠️ [applyPartialUpdate] Skipping Strategy 4 for UPDATE artifact - chained updates must have their own selection context',
    );
  }

  // If no valid selection context, treat as FULL REPLACEMENT for update artifacts
  // This is safe for chained updates where we don't have line/column info
  if (
    !cachedSelection ||
    typeof cachedSelection.startLine !== 'number' ||
    typeof cachedSelection.endLine !== 'number' ||
    typeof cachedSelection.startColumn !== 'number' ||
    typeof cachedSelection.endColumn !== 'number'
  ) {
    return originalContent; // Keep base unchanged - snippet is in update artifact
  }

  // --- Precise merging using line and column ---
  const startLine = cachedSelection.startLine;
  const endLine = cachedSelection.endLine;
  const startColumn = cachedSelection.startColumn;
  const endColumn = cachedSelection.endColumn;
  const lines = originalContent.split('\n');
  if (typeof updateContent === 'undefined') return originalContent;
  const updateLines = updateContent.split('\n');

  console.log('📍 [MERGE LOCATION] Starting precise merge:', {
    startLine,
    endLine,
    startColumn,
    endColumn,
    totalLinesInOriginal: lines.length,
    linesBeingReplaced: endLine - startLine + 1,
  });

  // Before applying update, check if updateContent already exists in originalContent
  // This prevents double text from appearing when coordinates are wrong
  if (updateContent && originalContent) {
    // Check if the exact update content already exists in the artifact
    const updateAlreadyExists = originalContent.includes(updateContent);

    if (updateAlreadyExists && cachedSelection?.originalText) {
      // Also check if the originalText exists - if both exist, this is likely a duplicate application
      const originalTextExists = originalContent.includes(cachedSelection.originalText);

      if (originalTextExists) {
        console.warn('⚠️ [DUPLICATION DETECTED] Update content already exists in artifact!', {
          updateContentLength: updateContent.length,
          updateContentPreview: updateContent.substring(0, 100),
          originalTextExists,
          decision: 'Attempting smart replacement instead of duplication',
        });

        // Try to replace originalText with updateContent (if they're different)
        if (cachedSelection.originalText !== updateContent) {
          const updatedContent = originalContent.replace(
            cachedSelection.originalText,
            updateContent,
          );

          if (updatedContent !== originalContent) {
            return updatedContent;
          }
        }
        return originalContent;
      }
    }
  }

  // This prevents updates from being applied to the wrong location
  // Even in sequential mode, we MUST validate originalText exists and find its correct location
  // EXCEPTION: If selection source is 'user' (manual UI selection), ALWAYS trust coordinates!
  if (cachedSelection?.originalText) {
    // User selections from the UI are ALWAYS accurate and current - never validate them!
    if (cachedSelection.source === 'user') {
      console.log('✅ [USER SELECTION] Skipping validation - user selections are always accurate', {
        source: cachedSelection.source,
        startLine: cachedSelection.startLine,
        endLine: cachedSelection.endLine,
        startColumn: cachedSelection.startColumn,
        endColumn: cachedSelection.endColumn,
        reason: 'Manual user selections from UI are current and trustworthy',
        WILL_USE_EXACT_COORDINATES: true,
      });
    }
    if (cachedSelection.source !== 'user') {
      let originalText = cachedSelection.originalText;

      const hasEscapedNewlines = originalText.indexOf('\\n') !== -1;
      const hasEscapedQuotes =
        originalText.indexOf('\\"') !== -1 || originalText.indexOf("\\'") !== -1;
      const hasStringConcat = originalText.includes("' + '");

      if (hasEscapedNewlines || hasEscapedQuotes || hasStringConcat) {

        // Remove string concatenation: ' + '
        let parsedText = originalText.replace(/'\s*\+\s*'/g, '');

        // Remove quotes at start/end if present (e.g., "text" -> text)
        parsedText = parsedText.replace(/^["']|["']$/g, '');

        // Unescape special characters
        parsedText = parsedText.replace(/\\n/g, '\n'); // \n -> actual newline
        parsedText = parsedText.replace(/\\"/g, '"'); // \" -> "
        parsedText = parsedText.replace(/\\'/g, "'"); // \' -> '
        parsedText = parsedText.replace(/\\\\/g, '\\'); // \\ -> \

        console.log('✅ [PARSING] Converted string syntax to actual text:', {
          before: originalText.substring(0, 100),
          after: parsedText.substring(0, 100),
          beforeLength: originalText.length,
          afterLength: parsedText.length,
        });

        originalText = parsedText;

        // Update the cached selection with parsed text for future searches
        cachedSelection = {
          ...cachedSelection,
          originalText: parsedText,
        };
      }

      const allOccurrences = originalContent.split(originalText).length - 1;
      if (allOccurrences > 1) {
        const allLines = originalContent.split('\n');

        // If originalText spans multiple lines, we need to search across line boundaries
        const isMultiLine = originalText.includes('\n');
        let lineLocations: Array<{
          line: number;
          contains: boolean;
          lineContent: string;
          columnIndex: number;
        }> = [];

        if (isMultiLine) {
          // Multi-line search: find all positions where the text starts
          console.log(
            '📝 [MULTI-LINE SEARCH] originalText spans multiple lines, searching across boundaries...',
          );

          let searchIndex = 0;
          while (searchIndex < originalContent.length) {
            const foundIndex = originalContent.indexOf(originalText, searchIndex);
            if (foundIndex === -1) break;

            // Calculate which line this occurrence starts on
            const textBeforeMatch = originalContent.substring(0, foundIndex);
            const lineNumber = textBeforeMatch.split('\n').length - 1;
            const lineStartIndex = textBeforeMatch.lastIndexOf('\n') + 1;
            const columnIndex = foundIndex - lineStartIndex;

            lineLocations.push({
              line: lineNumber,
              contains: true,
              lineContent: allLines[lineNumber],
              columnIndex: columnIndex,
            });

            searchIndex = foundIndex + 1;
          }
        } else {
          // Single-line search: check each line individually (faster)
          lineLocations = allLines
            .map((lineContent, idx) => ({
              line: idx,
              contains: lineContent.includes(originalText),
              lineContent: lineContent,
              columnIndex: lineContent.indexOf(originalText),
            }))
            .filter((item) => item.contains);
        }


        // CRITICAL FIX: Filter occurrences by HTML section (body, style, script)
        // This prevents matching HTML in <style> when it should be in <body>
        const bodyStart = originalContent.indexOf('<body>');
        const bodyEnd = originalContent.indexOf('</body>');
        const styleStart = originalContent.indexOf('<style>');
        const styleEnd = originalContent.indexOf('</style>');
        const _scriptStart = originalContent.indexOf('<script>');
        const _scriptEnd = originalContent.indexOf('</script>');

        // Determine which section the PROVIDED coordinates point to
        const targetInBody =
          bodyStart !== -1 &&
          bodyEnd !== -1 &&
          startLine >= allLines.slice(0, bodyStart).join('\n').split('\n').length &&
          startLine <= allLines.slice(0, bodyEnd).join('\n').split('\n').length;

        const targetInStyle =
          styleStart !== -1 &&
          styleEnd !== -1 &&
          startLine >= allLines.slice(0, styleStart).join('\n').split('\n').length &&
          startLine <= allLines.slice(0, styleEnd).join('\n').split('\n').length;


        // Filter occurrences to ONLY those in the same section as target
        const filteredLocations = lineLocations.filter((loc) => {
          const locInBody =
            bodyStart !== -1 &&
            bodyEnd !== -1 &&
            loc.line >= allLines.slice(0, bodyStart).join('\n').split('\n').length &&
            loc.line <= allLines.slice(0, bodyEnd).join('\n').split('\n').length;

          const locInStyle =
            styleStart !== -1 &&
            styleEnd !== -1 &&
            loc.line >= allLines.slice(0, styleStart).join('\n').split('\n').length &&
            loc.line <= allLines.slice(0, styleEnd).join('\n').split('\n').length;

          // Keep if in same section as target
          if (targetInBody) return locInBody;
          if (targetInStyle) return locInStyle;
          return true; // Keep if no section info
        });

        console.log('✅ [SECTION FILTER] Filtered to same section:', {
          beforeFilter: lineLocations.length,
          afterFilter: filteredLocations.length,
          keptLines: filteredLocations.map((loc) => loc.line),
        });

        // Use filtered locations for subsequent disambiguation
        // If filtering eliminated all matches, fall back to original list
        const locationsForDisambiguation =
          filteredLocations.length > 0 ? filteredLocations : lineLocations;


        // 🧠 ELEMENT-AWARE DISAMBIGUATION HELPER
        // Extract element type and context from a line
        const extractElementContext = (lineContent: string, lineIndex: number) => {
          // Extract element tag name (e.g., <button>, <input>, <div>)
          const elementMatch = lineContent.match(/<(\w+)[\s>]/);
          const elementType = elementMatch ? elementMatch[1].toLowerCase() : null;

          // Extract unique attributes (id, onClick, type, name, etc.)
          const idMatch = lineContent.match(/\bid=["']([^"']+)["']/);
          const onClickMatch = lineContent.match(/\bonClick=/);
          const typeMatch = lineContent.match(/\btype=["']([^"']+)["']/);
          const nameMatch = lineContent.match(/\bname=["']([^"']+)["']/);
          const dataMatch = lineContent.match(/\bdata-[\w-]+=["']([^"']+)["']/);

          // Calculate context score - how unique/specific is this line?
          let contextScore = 0;
          if (idMatch) contextScore += 10; // IDs are very unique
          if (onClickMatch) contextScore += 5; // Event handlers are fairly unique
          if (typeMatch) contextScore += 3;
          if (nameMatch) contextScore += 3;
          if (dataMatch) contextScore += 2;
          if (elementType) contextScore += 1;

          return {
            lineIndex,
            elementType,
            hasId: !!idMatch,
            hasOnClick: !!onClickMatch,
            hasType: !!typeMatch,
            hasName: !!nameMatch,
            hasDataAttr: !!dataMatch,
            contextScore,
            lineContent,
          };
        };

        // Extract context for each occurrence (use filtered locations!)
        const locationsWithContext = locationsForDisambiguation.map((loc) => ({
          ...loc,
          context: extractElementContext(allLines[loc.line], loc.line),
        }));

        // Extract context for the TARGET line (what LLM specified)
        const targetLineContext =
          startLine < allLines.length
            ? extractElementContext(allLines[startLine], startLine)
            : null;

        console.log('🧠 [ELEMENT-AWARE DISAMBIGUATION] Analyzing element context:', {
          targetLine: startLine,
          targetElementType: targetLineContext?.elementType,
          targetContextScore: targetLineContext?.contextScore,
          allOccurrences: locationsWithContext.map((loc) => ({
            line: loc.line,
            elementType: loc.context.elementType,
            contextScore: loc.context.contextScore,
            hasId: loc.context.hasId,
            hasOnClick: loc.context.hasOnClick,
            linePreview: loc.context.lineContent.substring(0, 80),
          })),
        });

        // STRATEGY 1: Try exact line + column match (best case)
        const exactMatch = locationsForDisambiguation.find(
          (loc) => loc.line === startLine && loc.columnIndex === startColumn,
        );

        if (exactMatch) {
          console.log('✅ [DISAMBIGUATION - EXACT] Found exact line + column match!', {
            foundAtLine: exactMatch.line,
            foundAtColumn: exactMatch.columnIndex,
            specifiedLine: startLine,
            specifiedColumn: startColumn,
            PROCEEDING: 'Using exact match',
          });
          // Coordinates are already correct - continue
        } else {
          // STRATEGY 2: Element-aware matching - prefer SAME element type near target line
          if (targetLineContext?.elementType) {
            const sameElementMatches = locationsWithContext.filter(
              (loc) =>
                loc.context.elementType === targetLineContext.elementType &&
                Math.abs(loc.line - startLine) <= 50,
            );

            if (sameElementMatches.length === 1) {
              // Only ONE match with same element type - SAFE to use!
              const match = sameElementMatches[0];

              // Update coordinates
              cachedSelection = {
                ...cachedSelection,
                startLine: match.line,
                endLine: match.line + (endLine - startLine),
                startColumn: match.columnIndex,
                endColumn: match.columnIndex + originalText.length,
              };
            } else if (sameElementMatches.length > 1) {
              // Multiple matches with same element type - use context score to pick best
              console.warn(
                '⚠️ [DISAMBIGUATION - ELEMENT TYPE] Multiple matches with same element type - using context scoring',
                {
                  elementType: targetLineContext.elementType,
                  matchCount: sameElementMatches.length,
                  matches: sameElementMatches.map((m) => ({
                    line: m.line,
                    contextScore: m.context.contextScore,
                    hasId: m.context.hasId,
                    hasOnClick: m.context.hasOnClick,
                  })),
                },
              );

              // Sort by: 1) context score (higher is better), 2) proximity to target line
              const bestMatch = sameElementMatches.sort((a, b) => {
                // First, prefer higher context scores
                if (a.context.contextScore !== b.context.contextScore) {
                  return b.context.contextScore - a.context.contextScore;
                }
                // If scores are equal, prefer closer to target line
                return Math.abs(a.line - startLine) - Math.abs(b.line - startLine);
              })[0];

              console.log('✅ [DISAMBIGUATION - CONTEXT SCORE] Picked best match by context:', {
                foundAtLine: bestMatch.line,
                contextScore: bestMatch.context.contextScore,
                elementType: bestMatch.context.elementType,
                hasId: bestMatch.context.hasId,
                hasOnClick: bestMatch.context.hasOnClick,
                PROCEEDING: 'Using highest context score match',
              });

              // Update coordinates
              cachedSelection = {
                ...cachedSelection,
                startLine: bestMatch.line,
                endLine: bestMatch.line + (endLine - startLine),
                startColumn: bestMatch.columnIndex,
                endColumn: bestMatch.columnIndex + originalText.length,
              };
            } else {
              // No matches with same element type in ±50 lines - this is suspicious!
              console.error(
                '❌ [DISAMBIGUATION - ELEMENT TYPE MISMATCH] No matches with same element type!',
                {
                  targetElementType: targetLineContext.elementType,
                  targetLine: startLine,
                  availableElements: locationsWithContext.map((loc) => ({
                    line: loc.line,
                    elementType: loc.context.elementType,
                  })),
                  CRITICAL: 'Element type mismatch - coordinates may be very wrong',
                  decision: 'Falling back to proximity-based matching',
                },
              );

              // Fall through to old strategies (proximity-based)
            }
          }

          // STRATEGY 3: Check ±50 lines with same column offset (fallback)
          const nearbyWithColumnMatch = locationsForDisambiguation.find(
            (loc) =>
              Math.abs(loc.line - startLine) <= 50 && Math.abs(loc.columnIndex - startColumn) <= 2,
          );

          if (nearbyWithColumnMatch && !cachedSelection.startLine) {
            console.log(
              '✅ [DISAMBIGUATION - NEARBY+COLUMN] Found nearby line with matching column:',
              {
                foundAtLine: nearbyWithColumnMatch.line,
                foundAtColumn: nearbyWithColumnMatch.columnIndex,
                specifiedLine: startLine,
                specifiedColumn: startColumn,
                lineOffset: nearbyWithColumnMatch.line - startLine,
                columnOffset: nearbyWithColumnMatch.columnIndex - startColumn,
                PROCEEDING: 'Using nearby match with correct column',
              },
            );
            // Update coordinates
            cachedSelection = {
              ...cachedSelection,
              startLine: nearbyWithColumnMatch.line,
              endLine: nearbyWithColumnMatch.line + (endLine - startLine),
              startColumn: nearbyWithColumnMatch.columnIndex,
              endColumn: nearbyWithColumnMatch.columnIndex + originalText.length,
            };
          }

          // STRATEGY 4: Just use nearest line within ±50 (ignore column for now)
          if (!cachedSelection.startLine || cachedSelection.startLine === startLine) {
            const nearbyOccurrence = locationsForDisambiguation.find(
              (loc) => Math.abs(loc.line - startLine) <= 50,
            );

            if (nearbyOccurrence) {
              cachedSelection = {
                ...cachedSelection,
                startLine: nearbyOccurrence.line,
                endLine: nearbyOccurrence.line + (endLine - startLine),
                startColumn: nearbyOccurrence.columnIndex,
                endColumn: nearbyOccurrence.columnIndex + originalText.length,
              };
            } else {
              // STRATEGY 5: No nearby match - find CLOSEST occurrence to specified line (anywhere in file)

              const closestOccurrence = locationsForDisambiguation.reduce(
                (closest, loc) =>
                  Math.abs(loc.line - startLine) < Math.abs(closest.line - startLine)
                    ? loc
                    : closest,
                locationsForDisambiguation[0],
              );

              console.warn('⚠️ [DISAMBIGUATION - CLOSEST] Using closest match as best guess:', {
                foundAtLine: closestOccurrence.line,
                foundAtColumn: closestOccurrence.columnIndex,
                specifiedLine: startLine,
                specifiedColumn: startColumn,
                lineOffset: closestOccurrence.line - startLine,
                columnOffset: closestOccurrence.columnIndex - startColumn,
                WARNING: 'Using furthest match - LLM coordinates may be very wrong',
                PROCEEDING: 'Using closest occurrence as fallback',
              });

              // Update coordinates to the closest occurrence
              cachedSelection = {
                ...cachedSelection,
                startLine: closestOccurrence.line,
                endLine: closestOccurrence.line + (endLine - startLine),
                startColumn: closestOccurrence.columnIndex,
                endColumn: closestOccurrence.columnIndex + originalText.length,
              };
            }
          }
        }
      }

      // NEW: Additional safety check - verify originalText is in the expected section
      // For HTML: check if we're in the right section (body, style, script)
      if (originalContent.includes('<body>') && originalContent.includes('</body>')) {
        const bodyStart = originalContent.indexOf('<body>');
        const bodyEnd = originalContent.indexOf('</body>');
        const styleStart = originalContent.indexOf('<style>');
        const styleEnd = originalContent.indexOf('</style>');
        const scriptStart = originalContent.indexOf('<script>');
        const scriptEnd = originalContent.indexOf('</script>');

        const originalTextPosition = originalContent.indexOf(originalText);

        // Determine which section the originalText is in
        let inBody = false;
        let inStyle = false;
        let inScript = false;

        if (bodyStart !== -1 && bodyEnd !== -1) {
          inBody = originalTextPosition >= bodyStart && originalTextPosition <= bodyEnd;
        }
        if (styleStart !== -1 && styleEnd !== -1) {
          inStyle = originalTextPosition >= styleStart && originalTextPosition <= styleEnd;
        }
        if (scriptStart !== -1 && scriptEnd !== -1) {
          inScript = originalTextPosition >= scriptStart && originalTextPosition <= scriptEnd;
        }


        // Warn if originalText contains HTML but is in style/script section
        const containsHTML = /<[^>]+>/.test(originalText);
        const containsCSS = /:\s*[^;]+;/.test(originalText);

        if (containsHTML && inStyle) {
          console.warn('⚠️ [VALIDATION WARNING] HTML-like text found in <style> section!', {
            originalText: originalText.substring(0, 100),
            warning: 'This might be in the wrong section',
          });
        }

        if (containsCSS && inBody) {
          console.warn('⚠️ [VALIDATION WARNING] CSS-like text found in <body> section!', {
            originalText: originalText.substring(0, 100),
            warning: 'Ensure this is inline style, not misplaced CSS rule',
          });
        }
      }

      // Extract the current text at the specified location
      let currentTextAtLocation = '';

      if (startLine === endLine) {
        // Single line selection
        currentTextAtLocation = lines[startLine]?.slice(startColumn, endColumn) || '';
      } else {
        // Multi-line selection
        const firstLinePart = lines[startLine]?.slice(startColumn) || '';
        const lastLinePart = lines[endLine]?.slice(0, endColumn) || '';
        const middleLines = lines.slice(startLine + 1, endLine);
        currentTextAtLocation = [firstLinePart, ...middleLines, lastLinePart].join('\n');
      }
      const lineNumbersAreValid = startLine >= 0 && endLine < lines.length;
      const textMatchesAtProvidedLines = currentTextAtLocation === cachedSelection.originalText;
      const bothAreValid = lineNumbersAreValid && textMatchesAtProvidedLines;

      if (!bothAreValid) {
        if (!lineNumbersAreValid) {
          console.error('❌ [VALIDATION ERROR] Line numbers are invalid!', {
            startLine,
            endLine,
            totalLines: lines.length,
            reason: 'Line numbers out of bounds',
          });
        }

        if (!textMatchesAtProvidedLines) {
          console.error(
            '❌ [VALIDATION ERROR] Text at provided lines does NOT match originalText!',
            {
              providedLines: `${startLine}-${endLine}`,
              textAtProvidedLines: currentTextAtLocation.substring(0, 200),
              expectedOriginalText: cachedSelection.originalText.substring(0, 200),
              reason: 'LLM provided wrong originalText or wrong line numbers',
            },
          );
        }
      }

      // 🚨 STRICT MODE: If BOTH don't match, try fallback search BUT log it as LLM error
      // In production, you might want to reject these updates entirely
      if (currentTextAtLocation !== cachedSelection.originalText) {


        let foundMatch = false;
        let newStartLine = startLine;
        let newEndLine = endLine;
        let newStartColumn = startColumn;
        let newEndColumn = endColumn;

        // EXPANDED SEARCH: Search in a window of ±30 lines (was ±5)
        // This handles cases where React components or HTML structure has shifted significantly
        const searchWindowStart = Math.max(0, startLine - 50);
        const searchWindowEnd = Math.min(lines.length - 1, endLine + 50);
        const isOriginalTextMultiLine = cachedSelection.originalText.includes('\n');

        for (let searchLine = searchWindowStart; searchLine <= searchWindowEnd; searchLine++) {
          // Try to find the originalText starting at this line
          if (startLine === endLine) {
            // Single-line search
            const line = lines[searchLine] || '';
            const columnIndex = line.indexOf(cachedSelection.originalText);

            if (columnIndex !== -1) {
              // Found it!
              newStartLine = searchLine;
              newEndLine = searchLine;
              newStartColumn = columnIndex;
              newEndColumn = columnIndex + cachedSelection.originalText.length;
              foundMatch = true;

              break;
            }
          } else {
            // Multi-line search - check if the text spans multiple lines starting here
            const searchEndLine = Math.min(lines.length - 1, searchLine + (endLine - startLine));
            const potentialMatch = lines.slice(searchLine, searchEndLine + 1).join('\n');

            if (potentialMatch.includes(cachedSelection.originalText)) {
              // Found it! Now find exact position
              const matchStart = potentialMatch.indexOf(cachedSelection.originalText);

              // Calculate which line the match starts on
              const beforeMatch = potentialMatch.substring(0, matchStart);
              const newlinesBefore = (beforeMatch.match(/\n/g) || []).length;
              const startLineOffset = newlinesBefore;

              newStartLine = searchLine + startLineOffset;
              newStartColumn = matchStart - beforeMatch.lastIndexOf('\n') - 1;
              if (newStartColumn < 0) newStartColumn = matchStart; // First line case

              // Calculate end position
              const textLines = cachedSelection.originalText.split('\n');
              if (textLines.length === 1) {
                newEndLine = newStartLine;
                newEndColumn = newStartColumn + cachedSelection.originalText.length;
              } else {
                newEndLine = newStartLine + textLines.length - 1;
                newEndColumn = textLines[textLines.length - 1].length;
              }

              let extractedText = '';
              if (newStartLine === newEndLine) {
                extractedText = lines[newStartLine]?.slice(newStartColumn, newEndColumn) || '';
              } else {
                const firstPart = lines[newStartLine]?.slice(newStartColumn) || '';
                const lastPart = lines[newEndLine]?.slice(0, newEndColumn) || '';
                const middleParts = lines.slice(newStartLine + 1, newEndLine);
                extractedText = [firstPart, ...middleParts, lastPart].join('\n');
              }

              if (extractedText === cachedSelection.originalText) {
                foundMatch = true;
                break;
              } else {
                console.warn(
                  '⚠️ [VALIDATION] Coordinates calculated but text mismatch - continuing search',
                  {
                    searchLine,
                    expectedLength: cachedSelection.originalText.length,
                    extractedLength: extractedText.length,
                    expectedPreview: cachedSelection.originalText.substring(0, 50),
                    extractedPreview: extractedText.substring(0, 50),
                  },
                );
                // Continue searching - this was a false positive
              }
            }
          }
        }

        if (foundMatch) {
          // Update the coordinates to use the corrected location
          console.log('🔧 [VALIDATION] Correcting line/column numbers:', {
            before: { startLine, endLine, startColumn, endColumn },
            after: {
              startLine: newStartLine,
              endLine: newEndLine,
              startColumn: newStartColumn,
              endColumn: newEndColumn,
            },
            correction: 'Using corrected location for merge',
          });

          // Update the local variables that will be used in the merge
          // We need to reassign because they were declared with const
          // So we'll use the new variables in the rest of the function
          cachedSelection = {
            ...cachedSelection,
            startLine: newStartLine,
            endLine: newEndLine,
            startColumn: newStartColumn,
            endColumn: newEndColumn,
          };

          // Re-extract lines with corrected positions for validation
          const correctedLines = originalContent.split('\n');
          if (newStartLine === newEndLine) {
            currentTextAtLocation =
              correctedLines[newStartLine]?.slice(newStartColumn, newEndColumn) || '';
          } else {
            const firstLinePart = correctedLines[newStartLine]?.slice(newStartColumn) || '';
            const lastLinePart = correctedLines[newEndLine]?.slice(0, newEndColumn) || '';
            const middleLines = correctedLines.slice(newStartLine + 1, newEndLine);
            currentTextAtLocation = [firstLinePart, ...middleLines, lastLinePart].join('\n');
          }

          // console.log('✅ [VALIDATION] Verified corrected location matches:', {
          //   matches: currentTextAtLocation === cachedSelection.originalText,
          // });
        } else {
          // ±50 line search failed - try GLOBAL search across entire file
          console.warn('⚠️ [VALIDATION] Could not find originalText in ±50 line range', {
            searchedLines: `${searchWindowStart} to ${searchWindowEnd}`,
            originalText: cachedSelection.originalText.substring(0, 100),
            decision: 'Attempting GLOBAL search across entire file',
          });

          // GLOBAL SEARCH: Search the entire file for originalText
          let globalFoundMatch = false;
          let globalStartLine = -1;
          let globalEndLine = -1;
          let globalStartColumn = -1;
          let globalEndColumn = -1;

          // Try to find it anywhere in the file
          for (let searchLine = 0; searchLine < lines.length; searchLine++) {
            if (cachedSelection.originalText.indexOf('\n') === -1) {
              // Single-line text
              const line = lines[searchLine];
              const columnIndex = line.indexOf(cachedSelection.originalText);
              if (columnIndex !== -1) {
                globalStartLine = searchLine;
                globalEndLine = searchLine;
                globalStartColumn = columnIndex;
                globalEndColumn = columnIndex + cachedSelection.originalText.length;
                globalFoundMatch = true;
                console.log('✅ [GLOBAL SEARCH] Found originalText at line', searchLine);
                break;
              }
            } else {
              // Multi-line text
              const textLines = cachedSelection.originalText.split('\n');
              const searchEndLine = Math.min(lines.length - 1, searchLine + textLines.length - 1);

              // Build potential match
              const potentialLines = lines.slice(searchLine, searchEndLine + 1);
              const potentialMatch = potentialLines.join('\n');

              if (potentialMatch === cachedSelection.originalText) {
                // Exact match found
                globalStartLine = searchLine;
                globalEndLine = searchEndLine;
                globalStartColumn = 0;
                globalEndColumn = lines[searchEndLine].length;
                globalFoundMatch = true;
                console.log(
                  '✅ [GLOBAL SEARCH] Found multi-line originalText starting at line',
                  searchLine,
                );
                break;
              } else if (potentialMatch.includes(cachedSelection.originalText)) {
                // Text found but need to calculate exact position
                const matchStart = potentialMatch.indexOf(cachedSelection.originalText);
                const beforeMatch = potentialMatch.substring(0, matchStart);
                const newlinesBefore = (beforeMatch.match(/\n/g) || []).length;

                globalStartLine = searchLine + newlinesBefore;
                globalStartColumn = matchStart - beforeMatch.lastIndexOf('\n') - 1;
                if (globalStartColumn < 0) globalStartColumn = matchStart;

                const textLineCount = textLines.length;
                if (textLineCount === 1) {
                  globalEndLine = globalStartLine;
                  globalEndColumn = globalStartColumn + cachedSelection.originalText.length;
                } else {
                  globalEndLine = globalStartLine + textLineCount - 1;
                  globalEndColumn = textLines[textLines.length - 1].length;
                }

                // Verify extraction
                let extracted = '';
                if (globalStartLine === globalEndLine) {
                  extracted =
                    lines[globalStartLine]?.slice(globalStartColumn, globalEndColumn) || '';
                } else {
                  const firstPart = lines[globalStartLine]?.slice(globalStartColumn) || '';
                  const lastPart = lines[globalEndLine]?.slice(0, globalEndColumn) || '';
                  const middleParts = lines.slice(globalStartLine + 1, globalEndLine);
                  extracted = [firstPart, ...middleParts, lastPart].join('\n');
                }

                if (extracted === cachedSelection.originalText) {
                  globalFoundMatch = true;
                  console.log(
                    '✅ [GLOBAL SEARCH] Found originalText with calculated coordinates at line',
                    globalStartLine,
                  );
                  break;
                }
              }
            }
          }

          if (globalFoundMatch) {

            // Update coordinates to the actual location
            cachedSelection = {
              ...cachedSelection,
              startLine: globalStartLine,
              endLine: globalEndLine,
              startColumn: globalStartColumn,
              endColumn: globalEndColumn,
            };

            // CRITICAL: Check if we're about to create a duplication
            // Extract what's currently at the CORRECTED coordinates
            const currentLines = originalContent.split('\n');
            let currentTextAtCoords = '';

            if (globalStartLine === globalEndLine) {
              currentTextAtCoords =
                currentLines[globalStartLine]?.slice(globalStartColumn, globalEndColumn) || '';
            } else {
              const firstPart = currentLines[globalStartLine]?.slice(globalStartColumn) || '';
              const lastPart = currentLines[globalEndLine]?.slice(0, globalEndColumn) || '';
              const middleParts = currentLines.slice(globalStartLine + 1, globalEndLine);
              currentTextAtCoords = [firstPart, ...middleParts, lastPart].join('\n');
            }

            console.warn('🔍 [VALIDATION] Text at CORRECTED coordinates:', {
              currentTextAtCoords: currentTextAtCoords.substring(0, 200),
              updateContent: updateContent.substring(0, 200),
              areIdentical: currentTextAtCoords === updateContent,
              WARNING:
                currentTextAtCoords === updateContent
                  ? '⚠️ UPDATE CONTENT SAME AS CURRENT - NO CHANGE NEEDED!'
                  : 'Different - will proceed with replacement',
            });

            // If the text at coordinates is identical to updateContent, skip the update
            if (currentTextAtCoords === updateContent) {
              console.log(
                '⏭️ [VALIDATION] Update content identical to current content - skipping update',
              );
              return originalContent;
            }
        } else {
          // FINAL FALLBACK: Could not find originalText anywhere
            console.error(
              '🚨 [GLOBAL SEARCH FAILED] Could not find originalText anywhere in file',
              {
                originalText: cachedSelection.originalText.substring(0, 100),
                decision: 'Using original coordinates as last resort',
                reason: 'originalText may have been replaced in previous update',
                WARNING: 'HIGH RISK OF DUPLICATION - Proceeding with provided coordinates',
                coordinates: {
                  startLine,
                  endLine,
                  startColumn,
                  endColumn,
                },
              },
            );

            // Extract what's currently at the specified coordinates
            const currentLines = originalContent.split('\n');
            let currentTextAtCoords = '';

            if (startLine === endLine) {
              currentTextAtCoords = currentLines[startLine]?.slice(startColumn, endColumn) || '';
            } else {
              const firstPart = currentLines[startLine]?.slice(startColumn) || '';
              const lastPart = currentLines[endLine]?.slice(0, endColumn) || '';
              const middleParts = currentLines.slice(startLine + 1, endLine);
              currentTextAtCoords = [firstPart, ...middleParts, lastPart].join('\n');
            }

            console.warn('🔍 [VALIDATION] Text at FALLBACK coordinates:', {
              currentTextAtCoords: currentTextAtCoords.substring(0, 200),
              updateContent: updateContent.substring(0, 200),
              areIdentical: currentTextAtCoords === updateContent,
              WARNING:
                currentTextAtCoords === updateContent
                  ? '⚠️ UPDATE CONTENT SAME AS CURRENT - NO CHANGE NEEDED!'
                  : 'Different - will proceed with replacement',
            });

            // If the text at coordinates is identical to updateContent, skip the update
            if (currentTextAtCoords === updateContent) {
              console.log(
                '⏭️ [VALIDATION] Update content identical to current content - skipping update',
              );
              return originalContent;
            }

            // Continue with the original coordinates - they're our best guess
            // The pre-merge duplication check (lines 636-677) will catch any duplication issues
          }
        }
      } else if (skipValidation) {
        // In sequential mode, we found originalText and it matches
        console.log('✅ [VALIDATION PASSED - SEQUENTIAL MODE] Original text found and located');
      } else {
        console.log('✅ [VALIDATION PASSED] Original text matches - safe to apply update');
      }
    } // END: LLM validation block (cachedSelection.source !== 'user')
  } else {
    console.warn('⚠️ [VALIDATION SKIPPED] No originalText in selection context');
  }

  // Re-extract line/column numbers (may have been corrected above)
  const finalStartLine = cachedSelection.startLine;
  const finalEndLine = cachedSelection.endLine;
  const finalStartColumn = cachedSelection.startColumn;
  const finalEndColumn = cachedSelection.endColumn;


  if (finalStartLine === finalEndLine) {
    console.log('📍 [SINGLE-LINE PATH] Entering single-line merge logic');

    // This usually means the LLM didn't provide proper coordinates
    if (finalStartColumn === 0 && finalEndColumn === 0 && cachedSelection?.originalText) {
      console.error('❌ [INVALID COORDINATES] Both startColumn and endColumn are 0!', {
        lineNumber: finalStartLine,
        line: lines[finalStartLine],
        originalText: cachedSelection.originalText.substring(0, 100),
        problem: 'LLM provided no column information - need to search for text',
        FIXING: 'Will search for originalText in current line',
      });

      const searchText = cachedSelection.originalText;
      const line = lines[finalStartLine] || '';

      // Try to find it on the specified line first
      let columnIndex = line.indexOf(searchText);
      let foundLine = finalStartLine;

      if (columnIndex !== -1) {
        console.log('✅ [COORDINATE FIX] Found text on specified line!', {
          foundAtColumn: columnIndex,
          willUse: `startColumn: ${columnIndex}, endColumn: ${columnIndex + searchText.length}`,
        });
 } else {
        // Text not on specified line - search nearby lines
        console.warn(
          '⚠️ [LINE NUMBER WRONG] Text not on specified line - searching entire file...',
          {
            specifiedLine: finalStartLine,
            lineContent: line,
            searchText: searchText.substring(0, 100),
          },
        );

        // Search all lines to find the text
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const col = lines[i].indexOf(searchText);
          if (col !== -1) {
            foundLine = i;
            columnIndex = col;
            found = true;
            console.log('✅ [GLOBAL SEARCH] Found text on different line!', {
              specifiedLine: finalStartLine,
              actualLine: i,
              lineOffset: i - finalStartLine,
              foundAtColumn: col,
            });
            break;
          }
        }

        if (!found) {
          console.error('❌ [SEARCH FAILED] Text not found anywhere in file!', {
            searchText: searchText.substring(0, 100),
            decision: 'Returning original content - cannot safely insert',
          });
          return originalContent;
        }
      }

      // Update the final coordinates with found location
      cachedSelection = {
        ...cachedSelection,
        startLine: foundLine,
        endLine: foundLine,
        startColumn: columnIndex,
        endColumn: columnIndex + searchText.length,
      };
    }

    // Single-line selection: replace only the substring
    // Use corrected line number if coordinates were fixed
    const useLine = cachedSelection?.startLine ?? finalStartLine;
    const line = lines[useLine] || '';
    // Use corrected coordinates if available
    const useStartColumn = cachedSelection?.startColumn ?? finalStartColumn;
    const useEndColumn = cachedSelection?.endColumn ?? finalEndColumn;

    let before = line.slice(0, useStartColumn);
    const after = line.slice(useEndColumn);

    // 🛡️ CRITICAL COLUMN COORDINATE VALIDATION
    const selectedText = line.slice(useStartColumn, useEndColumn);
    const reconstructedLine = before + selectedText + after;

    // If reconstruction doesn't match, the column coordinates are wrong
    if (reconstructedLine !== line) {
      console.error('❌ [CRITICAL ERROR] Column coordinates are INCORRECT!', {
        originalLine: `"${line}"`,
        before: `"${before}"`,
        selectedText: `"${selectedText}"`,
        after: `"${after}"`,
        reconstructed: `"${reconstructedLine}"`,
        problem: 'before + selected + after does not equal original line',
        coordinates: { finalStartColumn, finalEndColumn },
        REFUSING: 'Cannot safely merge with wrong column coordinates',
      });

      // Return original content unchanged - DO NOT apply merge with wrong coordinates
      return originalContent;
    }

    console.log('✅ [COLUMN VALIDATION PASSED] Coordinates are correct');

    console.log('🎯 [SINGLE LINE UPDATE]:', {
      lineNumber: finalStartLine,
      originalLine: line,
      selectedPortion: line.slice(finalStartColumn, finalEndColumn),
      before: before,
      after: after,
      updateContent: updateContent,
      willBecome: before + updateContent + after,
    });

    console.log(
      'updateContent artifactutlis',
      updateContent,
      'before:',
      before,
      'after:',
      after,
      finalStartLine,
      finalEndLine,
    );

    // CRITICAL: If updateContent has newlines but we're replacing a single line,
    // we need to handle it as a multi-line replacement
    // NOTE: updateLines is already declared at line 649, don't redeclare it here
    console.log('updateLinesLength', updateLines.length);

    if (updateContent.includes('\n') && updateLines.length > 0 && before.trim()) {
      const beforeTrimmed = before.trim();
      const firstUpdateLineTrimmed = updateLines[0].trim();

      // Check if the first line of the update starts with the same text as 'before'
      // This would create: "const [todos, setTodos] = useState([{const [todos, setTodos] = useState(["
      if (firstUpdateLineTrimmed.startsWith(beforeTrimmed)) {
        console.error('🚨 DUPLICATE/NESTED CODE DETECTED!', {
          before: `"${before}"`,
          firstUpdateLine: `"${updateLines[0]}"`,
          problem: 'First update line contains the "before" text - would create nesting',
          FIXING: 'Will remove "before" prefix to prevent duplication',
        });

        // The update already contains the full line - don't add 'before' prefix
        before = '';
      }

      // ADDITIONAL CHECK: If 'before' contains significant code (not just whitespace/punctuation)
      // and the first update line also contains that code, we're likely about to duplicate
      const beforeCode = before.replace(/[\s{[(]/g, '').substring(0, 20); // Extract meaningful chars
      if (beforeCode.length > 5 && firstUpdateLineTrimmed.includes(beforeCode)) {
        console.error('🚨 DUPLICATE CODE PATTERN DETECTED!', {
          beforeCode: `"${beforeCode}"`,
          firstUpdateLine: `"${updateLines[0]}"`,
          problem: 'First update line contains code from "before" - likely duplication',
          FIXING: 'Clearing "before" to use update content as-is',
        });
        before = '';
      }

      if (before.trim() === '' && firstUpdateLineTrimmed.length > 10) {
        // Check if the current line (with 'before' + what we're replacing) forms complete code
        const currentLineComplete = line.trim();
        // Check if first update line could be the start of that same code
        if (
          currentLineComplete.length > 0 &&
          firstUpdateLineTrimmed.substring(0, 20) === currentLineComplete.substring(0, 20)
        ) {
          console.error('🚨 FULL LINE REPLACEMENT DETECTED!', {
            beforeIsIndentation: `"${before}" (just indentation)`,
            firstUpdateLine: `"${updateLines[0]}"`,
            currentLine: `"${currentLineComplete}"`,
            problem: 'Update starts with same code as current line - this is a replacement',
            FIXING: 'The update already includes indentation, clearing "before"',
          });
          before = '';
        }
      }
    }

    if (updateContent.includes('\n') && updateLines.length > 1) {
      const lastUpdateLine = updateLines[updateLines.length - 1];
      const afterTrimmed = after.trim();

      let adjustedAfter = after;

      // Check 1: Does the last update line end with the same text as 'after'?
      if (afterTrimmed && lastUpdateLine.trim().endsWith(afterTrimmed)) {
        console.warn(
          '🚨 [DUPLICATION PREVENTION #1] Last update line already ends with "after" text!',
          {
            lastUpdateLine: `"${lastUpdateLine}"`,
            after: `"${after}"`,
            problem: 'Would create duplicate text at end of line',
            FIXING: 'Clearing "after" to prevent duplication',
          },
        );
        adjustedAfter = '';
      }

      // Check 2: Does the last update line already contain the 'after' text somewhere?
      // This catches cases where after = "      }" but lastUpdateLine = "something }      "
      if (afterTrimmed && adjustedAfter && lastUpdateLine.includes(afterTrimmed)) {
        console.warn(
          '🚨 [DUPLICATION PREVENTION #2] Last update line already contains "after" text!',
          {
            lastUpdateLine: `"${lastUpdateLine}"`,
            after: `"${after}"`,
            problem: 'Would create duplicate text (found in middle of line)',
            FIXING: 'Clearing "after" to prevent duplication',
          },
        );
        adjustedAfter = '';
      }

      // Check 3: Does the entire update content already end with the 'after' text?
      // This catches cases where the LLM included the trailing text in their update
      if (afterTrimmed && adjustedAfter && updateContent.trim().endsWith(afterTrimmed)) {
        console.warn(
          '🚨 [DUPLICATION PREVENTION #3] Update content already ends with "after" text!',
          {
            updateContentEnd: `"${updateContent.slice(-50)}"`,
            after: `"${after}"`,
            problem: 'LLM included trailing text in their update',
            FIXING: 'Clearing "after" to prevent duplication',
          },
        );
        adjustedAfter = '';
      }

      const firstLine = before + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + adjustedAfter;
      const middleLines = updateLines.slice(1, -1);

      const newLines = [
        ...lines.slice(0, finalStartLine),
        firstLine,
        ...middleLines,
        lastLine,
        ...lines.slice(finalStartLine + 1),
      ];
      console.log('Result lines:', newLines);

      // 🔍 FINAL SAFETY CHECK: Verify we didn't create duplicate lines
      if (newLines[finalStartLine] && newLines[finalStartLine + 1]) {
        const line1Trimmed = newLines[finalStartLine].trim();
        const line2Trimmed = newLines[finalStartLine + 1].trim();
        if (line1Trimmed && line2Trimmed && line1Trimmed === line2Trimmed) {
          console.error('🚨🚨🚨 CRITICAL: Duplicate lines detected in result!', {
            line1: newLines[finalStartLine],
            line2: newLines[finalStartLine + 1],
            REFUSING_TO_APPLY: true,
            RETURNING_ORIGINAL: true,
          });
          return originalContent; // Refuse to apply - return original unchanged
        }
      }

      const result = newLines.join('\n');
      const finalResult = result.replace(/\n$/, ''); // Strip only the last newline

      console.log('🎯 [FINAL SINGLE-LINE MULTI-LINE-UPDATE RESULT]:', {
        affectedLineRange: `${finalStartLine} to ${finalStartLine + updateLines.length}`,
        resultPreview: finalResult.substring(
          Math.max(0, finalResult.indexOf(firstLine) - 100),
          Math.min(finalResult.length, finalResult.indexOf(firstLine) + 500),
        ),
        firstThreeResultLines: finalResult.split('\n').slice(finalStartLine, finalStartLine + 3),
      });

      return finalResult;
    }

    lines[useLine] = before + updateContent + after;
    console.log('lines after single line update artifactutls', lines[useLine], updateContent);
    const result = lines.join('\n');

    // CRITICAL: Post-merge sanitization to fix common merge artifacts
    const sanitizedResult = _sanitizeMergeResult(result);

    return sanitizedResult;
  } else {
    // Multi-line selection: replace partial start/end lines and all lines in between
    const beforeStart = lines[finalStartLine]?.slice(0, finalStartColumn) || '';
    const afterEnd = lines[finalEndLine]?.slice(finalEndColumn) || '';
    const before = lines.slice(0, finalStartLine);
    const after = lines.slice(finalEndLine + 1);

    // Verify that the selected text actually exists across the specified lines
    const firstLineOriginal = lines[finalStartLine] || '';
    const lastLineOriginal = lines[finalEndLine] || '';
    const selectedFirstPart = firstLineOriginal.slice(finalStartColumn);
    const selectedLastPart = lastLineOriginal.slice(0, finalEndColumn);

    let correctedEndColumn = finalEndColumn;
    let correctedAfterEnd = afterEnd;
    let correctedSelectedLastPart = selectedLastPart;

    if (finalEndColumn > 0 && finalEndColumn < lastLineOriginal.length * 0.5) {
      // End column is less than halfway through the line - likely wrong
      const afterEndContent = afterEnd.trim();
      // Check if afterEnd contains HTML/JSX fragments that suggest wrong position
      if (
        afterEndContent.match(/^["']?[vp]>/i) ||
        afterEndContent.includes('/>') ||
        afterEndContent.includes('</')
      ) {
        console.error('🚨 [SUSPICIOUS COORDINATES DETECTED] End column is in middle of HTML tag!', {
          endColumn: finalEndColumn,
          lineLength: lastLineOriginal.length,
          lastLineOriginal: `"${lastLineOriginal}"`,
          afterEnd: `"${afterEnd}"`,
          problem: 'afterEnd contains HTML fragment - column coordinate is wrong',
          SOLUTION: 'Auto-correcting to end of line',
        });

        correctedEndColumn = lastLineOriginal.length;
        correctedAfterEnd = '';
        correctedSelectedLastPart = lastLineOriginal;
      }
    }

    // Use corrected values for validation and merge
    const finalAfterEnd = correctedAfterEnd;
    const finalSelectedLastPart = correctedSelectedLastPart;

    // Validate first line
    const firstLineReconstructed = beforeStart + selectedFirstPart;
    if (firstLineReconstructed !== firstLineOriginal) {
      console.error('❌ [CRITICAL ERROR] Start column coordinate is INCORRECT!', {
        firstLineOriginal: `"${firstLineOriginal}"`,
        firstLineLength: firstLineOriginal.length,
        startColumn: finalStartColumn,
        beforeStart: `"${beforeStart}"`,
        beforeStartLength: beforeStart.length,
        selectedFirstPart: `"${selectedFirstPart}"`,
        selectedFirstPartLength: selectedFirstPart.length,
        reconstructed: `"${firstLineReconstructed}"`,
        reconstructedLength: firstLineReconstructed.length,
        problem: 'beforeStart + selected does not equal original first line',
        REFUSING: 'Cannot safely merge with wrong column coordinates',
      });
      return originalContent;
    }

    // Validate last line with CORRECTED values (CRITICAL FIX!)
    const lastLineReconstructed = finalSelectedLastPart + finalAfterEnd;
    if (lastLineReconstructed !== lastLineOriginal) {

      return originalContent;
    }

    console.log('✅ [MULTI-LINE COLUMN VALIDATION PASSED] Coordinates are correct');

    const selectedTextForDeletion =
      finalStartLine === finalEndLine
        ? lines[finalStartLine]?.slice(finalStartColumn, finalEndColumn) || ''
        : (() => {
            const firstPart = lines[finalStartLine]?.slice(finalStartColumn) || '';
            const lastPart = lines[finalEndLine]?.slice(0, finalEndColumn) || '';
            const middleParts = lines.slice(finalStartLine + 1, finalEndLine);
            return [firstPart, ...middleParts, lastPart].join('\n');
          })();

    // Check if we're deleting important closing tags that might be unrelated to the update
    const closingTagsInDeleted = selectedTextForDeletion.match(/<\/[\w-]+>/g) || [];
    const closingTagsInUpdate = updateContent.match(/<\/[\w-]+>/g) || [];

    // Check for critical closing brackets/tags: </select>, </div>, </button>, etc.
    const criticalClosingTags = ['</select>', '</form>', '</table>', '</tbody>', '</thead>'];
    const deletingCriticalTags = closingTagsInDeleted.filter((tag) =>
      criticalClosingTags.includes(tag.toLowerCase()),
    );

    if (deletingCriticalTags.length > 0 && closingTagsInUpdate.length === 0) {

      // Additional check: Are these tags actually part of what should be replaced?
      // If originalText doesn't include these tags, we might be deleting too much
      if (
        cachedSelection?.originalText &&
        !cachedSelection.originalText.includes(deletingCriticalTags[0])
      ) {
        console.error('❌ [CRITICAL ERROR] Coordinates include closing tags NOT in originalText!', {
          originalText: cachedSelection.originalText.substring(0, 200),
          missingTags: deletingCriticalTags,
          problem: 'Selection coordinates extend beyond what LLM specified as originalText',
          REFUSING: 'Cannot safely delete unrelated closing tags',
          SOLUTION: 'Adjust endColumn to not include these tags, or return original content',
        });

        // REFUSE the update - coordinates are wrong and would delete unrelated content
        return originalContent;
      }
    }

    // If startColumn is 0 and endColumn is at end of line, don't add prefix/suffix
    const isFullLineSelection =
      finalStartColumn === 0 &&
      (finalAfterEnd.trim() === '' || correctedEndColumn === (lines[finalEndLine]?.length || 0));

    // 🔍 REACT SAFETY CHECK FOR MULTI-LINE: Detect duplicate/nested code patterns
    // This happens when beforeStart is just indentation but the update includes the full line
    let effectiveBeforeStart = beforeStart;
    if (beforeStart.trim() === '' && updateLines.length > 0) {
      const firstUpdateLineTrimmed = updateLines[0].trim();
      const originalFirstLineTrimmed = lines[finalStartLine]?.trim() || '';

      // Check if the first update line matches the beginning of the original line
      if (
        originalFirstLineTrimmed.length > 10 &&
        firstUpdateLineTrimmed.length > 10 &&
        firstUpdateLineTrimmed.substring(0, 20) === originalFirstLineTrimmed.substring(0, 20)
      ) {
        console.error('🚨 MULTI-LINE DUPLICATE DETECTED!', {
          beforeStart: `"${beforeStart}" (indentation only)`,
          originalLine: `"${originalFirstLineTrimmed}"`,
          firstUpdateLine: `"${firstUpdateLineTrimmed}"`,
          problem: 'Update includes full line with indentation, but beforeStart adds more',
          FIXING: 'Clearing beforeStart to prevent duplication',
        });
        effectiveBeforeStart = '';
      }
    }

    let mergedUpdateLines: string[] = [];

    if (isFullLineSelection) {
      // Full line selection - just use the update content as-is
      //console.log('✅ Full line selection detected - using update content directly');
      mergedUpdateLines = updateLines;
    } else if (updateLines.length === 1) {
      // Single update line replaces the whole region - add prefix and suffix
      //console.log('✅ Single-line replacement in multi-line selection');
      // CRITICAL FIX: Do NOT trim() - it removes important whitespace and corrupts content!
      mergedUpdateLines = [effectiveBeforeStart + updateLines[0] + finalAfterEnd];
    } else {
      // More than one line: first line gets prefix, last gets suffix, middle lines as-is
      // CRITICAL: ALWAYS add prefix and suffix, even if they're whitespace
      // Whitespace matters for indentation! Only skip if they're empty strings.
      // CRITICAL FIX: Do NOT trim() - it removes important whitespace and corrupts content!
      const firstLine = effectiveBeforeStart + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + finalAfterEnd;

      mergedUpdateLines = [firstLine, ...updateLines.slice(1, -1), lastLine];

    }

    // 🛡️ CRITICAL: Ensure proper line breaks between merged content and remaining lines
    // The join('\n') operation should add newlines between ALL array elements
    const finalMergedUpdateLines = [...mergedUpdateLines];

    console.log('🔧 [LINE BREAK VERIFICATION]:', {
      beforeCount: before.length,
      mergedUpdateLinesCount: mergedUpdateLines.length,
      afterCount: after.length,
      lastBeforeLine: before.length > 0 ? `"${before[before.length - 1]}"` : '(empty)',
      firstMergedLine: mergedUpdateLines.length > 0 ? `"${mergedUpdateLines[0]}"` : '(empty)',
      lastMergedLine:
        mergedUpdateLines.length > 0
          ? `"${mergedUpdateLines[mergedUpdateLines.length - 1]}"`
          : '(empty)',
      firstAfterLine: after.length > 0 ? `"${after[0]}"` : '(empty)',
      finalAfterEndValue: `"${finalAfterEnd}"`,
    });

    // Verify that join('\n') will add proper newlines
    // Between arrays: [...before, ...merged, ...after] means:
    // - before[last] + '\n' + merged[0]
    // - merged[last] + '\n' + after[0]
    if (mergedUpdateLines.length > 0 && after.length > 0) {
      const lastMergedLine = mergedUpdateLines[mergedUpdateLines.length - 1];
      const firstAfterLine = after[0];

      if (lastMergedLine !== undefined && firstAfterLine !== undefined) {
        console.log('✅ [LINE BREAK ASSURED]: join("\\n") will add newline between:', {
          lastMergedLine: `"${lastMergedLine}"`,
          firstAfterLine: `"${firstAfterLine}"`,
          resultWillBe: `"${lastMergedLine}\\n${firstAfterLine}"`,
        });
      }
    }

    if (before.length > 0 && mergedUpdateLines.length > 0) {
      const lastBeforeLine = before[before.length - 1];
      const firstMergedLine = mergedUpdateLines[0];

      if (lastBeforeLine !== undefined && firstMergedLine !== undefined) {
        console.log('✅ [LINE BREAK ASSURED]: join("\\n") will add newline between:', {
          lastBeforeLine: `"${lastBeforeLine}"`,
          firstMergedLine: `"${firstMergedLine}"`,
          resultWillBe: `"${lastBeforeLine}\\n${firstMergedLine}"`,
        });
      }
    }

    const mergedContent = [...before, ...finalMergedUpdateLines, ...after].join('\n');

    console.log('🔥🔥🔥 [FINAL ARRAY MERGE]:', {
      beforeLinesCount: before.length,
      beforeLastLine: before.length > 0 ? before[before.length - 1] : '(empty)',
      finalMergedUpdateLinesCount: finalMergedUpdateLines.length,
      finalMergedUpdateLines: finalMergedUpdateLines,
      afterLinesCount: after.length,
      afterFirstLine: after.length > 0 ? after[0] : '(empty)',
      CRITICAL: `Deleted lines ${finalStartLine}-${finalEndLine}, replaced with ${finalMergedUpdateLines.length} new lines`,
      resultLineCount: mergedContent.split('\n').length,
      originalLineCount: lines.length,
      lineDifference: mergedContent.split('\n').length - lines.length,
    });

    // 🔍 FINAL SAFETY CHECK: Verify we didn't create duplicate consecutive lines
    const mergedLines = mergedContent.split('\n');
    for (let i = 0; i < mergedLines.length - 1; i++) {
      const line1Trimmed = mergedLines[i].trim();
      const line2Trimmed = mergedLines[i + 1].trim();
      if (
        line1Trimmed &&
        line2Trimmed &&
        line1Trimmed.length > 10 &&
        line1Trimmed === line2Trimmed
      ) {
        console.error(
          '🚨🚨🚨 CRITICAL: Duplicate consecutive lines detected in multi-line merge!',
          {
            lineNumber: i,
            line1: mergedLines[i],
            line2: mergedLines[i + 1],
            REFUSING_TO_APPLY: true,
            RETURNING_ORIGINAL: true,
          },
        );
        return originalContent; // Refuse to apply - return original unchanged
      }
    }

    return mergedContent;
  }
}

export function applyAllPartialUpdates(
  originalContent: string,
  artifacts: Record<string, any> | null,
  targetArtifactId?: string,
  isStreaming?: boolean,
  conversationId?: string | null,
) {
  // CRITICAL: Capture the call stack to identify WHERE this is being called from
  const callStack = new Error().stack;
  const callSite = callStack?.split('\n')[2]?.trim() || 'UNKNOWN';

  // console.log(
  //   '🚀🚀🚀 [applyAllPartialUpdates] ==================== ENTRY POINT ====================',
  // );
  // console.log('🚀🚀🚀 [applyAllPartialUpdates] CALLED FROM:', callSite);
  // console.log('🚀🚀🚀 [applyAllPartialUpdates] PARAMETERS:', {
  //   originalContentIsNull: originalContent === null,
  //   originalContentIsUndefined: originalContent === undefined,
  //   originalContentIsEmpty: originalContent === '',
  //   originalContentType: typeof originalContent,
  //   originalContentLength: originalContent?.length || 0,
  //   originalContentPreview: originalContent?.substring(0, 150) || 'EMPTY/NULL',
  //   artifactsCount: artifacts ? Object.keys(artifacts).length : 0,
  //   targetArtifactId,
  //   isStreaming,
  //   allArtifactIds: artifacts ? Object.keys(artifacts) : [],
  //   HAS_DUPLICATION: originalContent
  //     ? (originalContent.match(/<!DOCTYPE/gi) || []).length > 1 ||
  //       (originalContent.match(/<html/gi) || []).length > 1
  //     : false,
  //   doctypeCount: originalContent ? (originalContent.match(/<!DOCTYPE/gi) || []).length : 0,
  //   htmlCount: originalContent ? (originalContent.match(/<html/gi) || []).length : 0,
  // });
  if (!artifacts) {
    console.warn('⚠️ [applyAllPartialUpdates] No artifacts provided, returning original content');
    return originalContent;
  }

  const targetArtifact = targetArtifactId ? artifacts[targetArtifactId] : null;
  const targetTime = targetArtifact?.lastUpdateTime || Infinity;

  console.log('🎯 [applyAllPartialUpdates] Target artifact info:', {
    targetArtifactId,
    targetArtifactFound: !!targetArtifact,
    targetIdentifier: targetArtifact?.identifier,
    targetIsUpdate: targetArtifact?.isUpdate,
    targetTime,
    targetContentLength: targetArtifact?.content?.length || 0,
  });

  // CRITICAL: Check if originalContent is already duplicated (from cache)
  // If so, find the BASE artifact (non-update) and use its content instead
  const contentHasDuplication = (content: string): boolean => {
    const doctypeMatches = (content.match(/<!DOCTYPE/gi) || []).length;
    const htmlMatches = (content.match(/<html/gi) || []).length;
    const titleMatches = (content.match(/<title>/gi) || []).length;
    return doctypeMatches > 1 || htmlMatches > 1 || titleMatches > 3;
  };

  let mergedContent = originalContent;

  // If the originalContent is already duplicated, find the base artifact
  if (contentHasDuplication(originalContent)) {
    console.warn('🚨 [applyAllPartialUpdates] DUPLICATION DETECTED in originalContent!', {
      doctypeCount: (originalContent.match(/<!DOCTYPE/gi) || []).length,
      htmlCount: (originalContent.match(/<html/gi) || []).length,
      titleCount: (originalContent.match(/<title>/gi) || []).length,
      action: 'Looking for base artifact content',
    });

    // Find the base (non-update) artifact with the same identifier
    // The identifier is SHARED between base and updates - don't split it
    const targetBaseIdentifier = targetArtifact?.identifier;

    const baseArtifact = Object.values(artifacts).find(
      (a: any) => !a.isUpdate && a.identifier === targetBaseIdentifier,
    );

    if (baseArtifact && baseArtifact.content && !contentHasDuplication(baseArtifact.content)) {
      console.log('✅ [applyAllPartialUpdates] Found clean base artifact:', {
        baseArtifactId: baseArtifact.id,
        baseIdentifier: baseArtifact.identifier,
        contentLength: baseArtifact.content.length,
      });
      mergedContent = baseArtifact.content;
    } else {
      console.error('❌ [applyAllPartialUpdates] Could not find clean base artifact!');
      return ''; // Or return some minimal safe content
    }
  }
  const targetBaseIdentifier = targetArtifact?.identifier;
  //console.log('artifacts', artifacts);
  const targetIndex = targetArtifact?.isUpdate
    ? (targetArtifact.index ??
      parseInt(targetArtifact.id?.match(/_update(\d+)_/)?.[1] || '999', 10))
    : -1; // If no target or target is base, DON'T apply any updates (show base only)

  const updateArtifacts = Object.values(artifacts)
    .filter((a: any) => {
      const _isUpdate = a && a.isUpdate === true;
      const _isWithinTimeRange =
        !targetArtifactId || (a.lastUpdateTime && a.lastUpdateTime <= targetTime);
      const _isSameBase = !targetBaseIdentifier || a?.identifier === targetBaseIdentifier;
      const indexMatch = a.id?.match(/_update(\d+)_/);
      const artifactIndex = a.index ?? (indexMatch ? parseInt(indexMatch[1], 10) : -1);
      const _isWithinIndexRange = artifactIndex === -1 || artifactIndex <= targetIndex;

      return _isUpdate && _isWithinTimeRange && _isSameBase && _isWithinIndexRange;
    })
    .sort((a: any, b: any) => {
      // Sort by lastUpdateTime first, then by index as fallback
      const timeA = a.lastUpdateTime || 0;
      const timeB = b.lastUpdateTime || 0;

      // Extract index from ID and artifact.index
      const indexA = a.index ?? parseInt(a.id?.match(/_update(\d+)_/)?.[1] || '0', 10);
      const indexB = b.index ?? parseInt(b.id?.match(/_update(\d+)_/)?.[1] || '0', 10);

      console.log('🔢 [SORT COMPARISON]:', {
        aId: a.id,
        bId: b.id,
        timeA,
        timeB,
        indexA,
        indexB,
        willSortBy: timeA !== timeB ? 'TIME' : 'INDEX',
        sortResult: timeA !== timeB ? timeA - timeB : indexA - indexB,
      });

      if (timeA !== timeB) {
        return timeA - timeB; // ASCENDING: earlier updates first
      }

      // If times are equal, sort by index
      return indexA - indexB; // ASCENDING: lower index first
    });

  console.log('updateArtifacts', updateArtifacts);

  // CRITICAL: If no update artifacts were found, return the original content
  if (updateArtifacts.length === 0) {
    console.warn('⚠️ [applyAllPartialUpdates] NO UPDATE ARTIFACTS FOUND!', {
      originalContentLength: mergedContent.length,
      targetArtifactId,
      targetBaseIdentifier,
      allArtifactIds: Object.keys(artifacts),
      allArtifacts: Object.values(artifacts).map((a) => ({
        id: a.id,
        identifier: a.identifier,
        isUpdate: a.isUpdate,
        hasContent: !!a.content,
      })),
    });
    return mergedContent; // Return original content if no updates to apply
  }

  let count = 0;
  console.log('🔄 [applyAllPartialUpdates] Starting sequential update application:', {
    totalUpdates: updateArtifacts.length,
    updateOrder: updateArtifacts.map(
      (u, i) => `${i}: ${u.id} (index=${u.index}, time=${u.lastUpdateTime})`,
    ),
  });

  // DEBUGGING: Dump ALL selection contexts from cache
  console.log('🔍🔍🔍 [applyAllPartialUpdates] SELECTION CACHE DUMP:');
  console.log('═'.repeat(80));
  const _allSelections = Array.from(artifactCache._selectionCache.entries());
  updateArtifacts.forEach((update, idx) => {
    const selection = artifactCache.getSelection(update.id);
    console.log(`\n📍 Update ${idx} (${update.id}):`);
    console.log(`   Has Selection: ${!!selection}`);
    if (selection) {
      console.log(`   Start Line: ${selection.startLine}`);
      console.log(`   End Line: ${selection.endLine}`);
      console.log(`   Start Column: ${selection.startColumn}`);
      console.log(`   End Column: ${selection.endColumn}`);
      console.log(`   Original Text: "${selection.originalText?.substring(0, 100)}..."`);
      console.log(`   Updated Text: "${selection.updatedText?.substring(0, 100)}..."`);
    } else {
      console.log(`   ⚠️ NO SELECTION CONTEXT - THIS UPDATE WILL FAIL!`);
    }
  });
  console.log('═'.repeat(80));

  // But EACH UPDATE MUST BUILD ON THE PREVIOUS MERGED RESULT!
  // Selection coordinates are stored per-update, not relative to base
  const baseContent = mergedContent; // Store the original base content for logging

  for (const updateArtifact of updateArtifacts) {
    const updateContent = (updateArtifact as any).snippetContent || updateArtifact.content;

    console.log(
      '🔄 [applyAllPartialUpdates] ========== Applying update #' + count + ' ==========',
      {
        updateNumber: count,
        totalUpdates: updateArtifacts.length,
        artifactId: updateArtifact.id,
        artifactIndex: updateArtifact.index,
        artifactTime: updateArtifact.lastUpdateTime,
        updateContentLength: updateArtifact.content?.length,
        updateContentPreview: updateArtifact.content,
        currentMergedContentLength: mergedContent.length,
        currentMergedContentPreview: mergedContent,
        baseContentLength: baseContent.length,
        isUpdate: updateArtifact.isUpdate,
      },
    );

    const newContent = applyPartialUpdate(
      mergedContent, // Build on previous updates sequentially
      updateContent,
      updateArtifact.id,
      count,
      artifacts, // Pass all artifacts for fallback selection lookup
      false,
    );

    if (newContent !== mergedContent) {
      console.log('✅ Content changed, updating mergedContent');
      mergedContent = newContent;
    } else {
      console.log('⏭️  Content unchanged, skipping');
    }
    count++;
  }

  // Final save: only persist merged content for UPDATE artifact (not base) to avoid overwriting original.
  console.log(
    '🎯 [applyAllPartialUpdates] Final merged content length:',
    mergedContent,
    targetArtifactId,
  );
  if (targetArtifactId && mergedContent !== originalContent) {
    const targetArtifact = artifacts[targetArtifactId];
    console.log('target Artifact before saving to cache:', targetArtifact);
    if (targetArtifact && targetArtifact.isUpdate) {
      console.log('mergedContent', mergedContent);
      artifactCache.setContent(targetArtifactId, mergedContent, {
        title: targetArtifact.title,
        type: targetArtifact.type,
        identifier: targetArtifact.identifier,
        source: 'directive',
        conversationId: conversationId || undefined,
      });
      console.log(
        '💾 Saved final merged (sanitized) content to cache for UPDATE artifact:',
        targetArtifactId,
      );
    } else if (targetArtifact && !targetArtifact.isUpdate) {
      console.log(
        '🔒 NOT saving merged content to base artifact to preserve original content:',
        targetArtifactId,
      );
    } else if (isStreaming) {
      console.log('⏸️ Skipping final cache save during streaming');
    }
  } else if (isStreaming) {
    console.log('⏸️ Skipping final cache save during streaming');
  }

  // 🔍 FINAL CHANGE DETECTION: Show exactly what changed
  logContentChanges(originalContent, mergedContent, targetArtifact?.title || 'unknown');

  return mergedContent;
}

/**
 * Helper function to detect and log the exact changes between original and merged content
 * This helps diagnose corruption issues by showing what actually changed
 */
function logContentChanges(originalContent: string, mergedContent: string, artifactTitle: string) {
  if (originalContent === mergedContent) {
    console.log('ℹ️ [NO CHANGES] Content is identical to original');
    return;
  }

  const originalLines = originalContent.split('\n');
  const mergedLines = mergedContent.split('\n');

  const changes: Array<{
    lineNum: number;
    type: 'added' | 'removed' | 'modified';
    original?: string;
    new?: string;
  }> = [];

  // Simple diff: compare line by line
  let originalIndex = 0;
  let mergedIndex = 0;

  while (originalIndex < originalLines.length || mergedIndex < mergedLines.length) {
    const originalLine = originalLines[originalIndex];
    const mergedLine = mergedLines[mergedIndex];

    if (originalLine === mergedLine) {
      // Lines match, continue
      originalIndex++;
      mergedIndex++;
    } else if (originalIndex >= originalLines.length) {
      // Added lines at the end
      changes.push({
        lineNum: mergedIndex + 1,
        type: 'added',
        new: mergedLine,
      });
      mergedIndex++;
    } else if (mergedIndex >= mergedLines.length) {
      // Removed lines at the end
      changes.push({
        lineNum: originalIndex + 1,
        type: 'removed',
        original: originalLine,
      });
      originalIndex++;
    } else {
      // Lines differ - could be modification, addition, or removal
      // Check if the merged line appears later in original (insertion)
      const mergedLineInOriginal = originalLines.indexOf(mergedLine, originalIndex + 1);
      // Check if the original line appears later in merged (deletion)
      const originalLineInMerged = mergedLines.indexOf(originalLine, mergedIndex + 1);

      if (mergedLineInOriginal !== -1 && mergedLineInOriginal - originalIndex < 5) {
        // Original line was removed
        changes.push({
          lineNum: originalIndex + 1,
          type: 'removed',
          original: originalLine,
        });
        originalIndex++;
      } else if (originalLineInMerged !== -1 && originalLineInMerged - mergedIndex < 5) {
        // New line was added
        changes.push({
          lineNum: mergedIndex + 1,
          type: 'added',
          new: mergedLine,
        });
        mergedIndex++;
      } else {
        // Line was modified
        changes.push({
          lineNum: originalIndex + 1,
          type: 'modified',
          original: originalLine,
          new: mergedLine,
        });
        originalIndex++;
        mergedIndex++;
      }
    }

    // Safety: prevent infinite loop
    if (changes.length > 1000) {
      console.warn('⚠️ Too many changes detected, stopping diff');
      break;
    }
  }

  console.log('🔍 [CHANGE DETECTION] Summary:', {
    artifact: artifactTitle,
    originalLineCount: originalLines.length,
    mergedLineCount: mergedLines.length,
    lineDifference: mergedLines.length - originalLines.length,
    totalChanges: changes.length,
    added: changes.filter((c) => c.type === 'added').length,
    removed: changes.filter((c) => c.type === 'removed').length,
    modified: changes.filter((c) => c.type === 'modified').length,
  });

  if (changes.length > 0 && changes.length <= 20) {
    console.log(
      '📝 [DETAILED CHANGES]:',
      changes
        .map((c) => {
          if (c.type === 'added') {
            return `  Line ${c.lineNum}: + "${c.new}"`;
          } else if (c.type === 'removed') {
            return `  Line ${c.lineNum}: - "${c.original}"`;
          } else {
            return `  Line ${c.lineNum}: ≠ "${c.original}" → "${c.new}"`;
          }
        })
        .join('\n'),
    );
  } else if (changes.length > 20) {
    console.log(
      '📝 [FIRST 10 CHANGES]:',
      changes
        .slice(0, 10)
        .map((c) => {
          if (c.type === 'added') {
            return `  Line ${c.lineNum}: + "${c.new?.substring(0, 80)}"`;
          } else if (c.type === 'removed') {
            return `  Line ${c.lineNum}: - "${c.original?.substring(0, 80)}"`;
          } else {
            return `  Line ${c.lineNum}: ≠ "${c.original?.substring(0, 40)}" → "${c.new?.substring(0, 40)}"`;
          }
        })
        .join('\n'),
    );
    console.log(`  ... and ${changes.length - 10} more changes`);
  }
}
