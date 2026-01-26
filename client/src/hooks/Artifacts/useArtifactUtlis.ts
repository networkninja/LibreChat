import { artifactCache } from '~/components/Artifacts/artifactCache';

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

  return fixed;
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

  const normalizeForComparison = (text: string): string => {
    let normalized = text;

    normalized = normalized.replace(/\\"/g, '"');  // \" → "
    normalized = normalized.replace(/\\'/g, "'");  // \' → '
    normalized = normalized.replace(/\\\\/g, '\\'); // \\\\ → \\

    normalized = normalized.replace(/\\n/g, '\n');

    if (normalized.startsWith('"') && (normalized.includes('${') || normalized.includes('`'))) {
      // Check for patterns like: "${...}" or "`...`" or "${...`}"
      if (normalized.match(/^"[\$`].*[`}]"$/)) {
        console.log('🔧 [NORMALIZATION] Removing malformed template literal wrapping quotes');
        normalized = normalized.slice(1, -1); // Remove first and last quote
      }
    }

    if (normalized.match(/\\n[`}]+["']?$/)) {
      console.log('🔧 [NORMALIZATION] Detected malformed template literal ending');
    }

    // 5. Normalize whitespace patterns (spaces vs tabs)
    normalized = normalized.replace(/\t/g, '  '); // Convert tabs to 2 spaces

    // 6. Normalize line endings (CRLF vs LF)
    normalized = normalized.replace(/\r\n/g, '\n');
    normalized = normalized
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');

    return normalized;
  };

  // CRITICAL: Extract base identifier EARLY so it's available for snippet logic
  artifactId = artifactId.toLowerCase();
  const baseIdentifier = artifactId.split('_update')[0];
  const isUpdateArtifact = artifactId.includes('_update');

  if (originalContent === updateContent) {
    console.log('No changes detected, skipping update.', artifactId);
    return originalContent;
  }

  if (isFullDoc(originalContent) && isSnippet(updateContent)) {
    //console.log('🩹 [Snippet Update] Detected snippet update to full document');

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

  // Use normalized and trimmed content for the rest of the function
  updateContent = trimmedUpdateContent;

  artifactId = artifactId.toLowerCase();

  if (artifactCache._selectionCache.size === 0) {
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
  const cachedSelectiontest = artifactCache._loadFromDatabase(artifactId);
  console.log('📍 [applyPartialUpdate] Strategy 1 result (exact ID match):', {
    artifactId,
    found: !!cachedSelection,
    selection: cachedSelection,
    selectionTest: cachedSelectiontest,
    CRITICAL_CHECK: {
      lookingFor: artifactId,
      availableKeys: Array.from(artifactCache._selectionCache.keys()),
      exactMatch: artifactCache._selectionCache.has(artifactId),
    },
  });

  // Strategy 1.5: If this is an update artifact and no selection found, try the base identifier
  if (!cachedSelection && isUpdateArtifact && baseIdentifier) {
    cachedSelection = artifactCache.getSelection(baseIdentifier);
    console.log('📍 [applyPartialUpdate] Strategy 1.5 result (base identifier):', {
      baseIdentifier,
      found: !!cachedSelection,
      selection: cachedSelection,
    });
  }

  // Strategy 1.75: Search by identifier substring match (most flexible)
  // This handles cases where the selection key has a timestamp or other suffix
  if (!cachedSelection && (baseIdentifier || artifactId)) {
    const updateIndexMatch = artifactId.match(/_update(\d+)_/);
    const updateIndex = updateIndexMatch ? parseInt(updateIndexMatch[1], 10) : null;
    // Fuzzy matching can cause update0's selection to be used for update1
    const exactMatch = allSelectionEntries.find(([key, _val]) => {
      return key.toLowerCase() === artifactId.toLowerCase();
    });

    if (exactMatch) {
      cachedSelection = exactMatch[1];
    } else if (updateIndex !== null) {
      // Strategy 1.6: If exact match failed but this is an update artifact,
      // try searching for selections with the same base identifier but different update indices
      // This handles the case where the update index was calculated differently
      console.warn('⚠️ [applyPartialUpdate] No exact match - trying adjacent update indices', {
        requestedArtifactId: artifactId,
        requestedUpdateIndex: updateIndex,
        allAvailableKeys: allSelectionEntries.map(([key]) => key),
      });

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
    // Try to find a selection context in allSelectionValues for this artifactId
    cachedSelection = allSelectionValues.find((cache) => cache.artifactId === artifactId);
  }

  // Strategy 4: Try previous artifact as fallback
  // For chained updates, each update MUST have its own selection context
  if (!cachedSelection && artifacts && !isUpdateArtifact) {
    console.log(
      '🔍 [applyPartialUpdate] Strategy 4: Looking for previous artifact selection (NON-UPDATE artifacts only)',
    );

    const artifactArray = Object.values(artifacts);

    // Sort artifacts by time (oldest to newest) to find the one that came just before this one
    const sortedArtifacts = artifactArray
      .filter((a) => a.id !== artifactId) // Exclude current artifact
      .sort((a, b) => a.lastUpdateTime - b.lastUpdateTime); // Oldest first

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
  let startLine = cachedSelection.startLine;
  let endLine = cachedSelection.endLine;
  let startColumn = cachedSelection.startColumn;
  let endColumn = cachedSelection.endColumn;
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
            console.log(
              '✅ [DUPLICATION AVOIDED] Successfully replaced originalText with updateContent',
            );
            return updatedContent;
          }
        }

        // If originalText and updateContent are the same, no change needed
        console.log(
          '⏭️ [DUPLICATION AVOIDED] originalText and updateContent are identical - returning unchanged',
        );
        return originalContent;
      }
    }
  }

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
      // Skip all validation - jump straight to merge with provided coordinates
    } else {
      console.log('🔍 [VALIDATION] Checking if originalText matches current content...', {
        skipValidation,
        source: cachedSelection.source || 'llm (default)',
        mode: skipValidation
          ? 'SEQUENTIAL (will search for originalText but skip exact match check)'
          : 'FULL VALIDATION',
        reason: 'LLM-provided coordinates may be stale after previous updates',
      });
    }

    if (cachedSelection.source !== 'user') {
      let originalText = cachedSelection.originalText;

      const hasEscapedNewlines = originalText.indexOf('\\n') !== -1;
      const hasEscapedQuotes =
        originalText.indexOf('\\"') !== -1 || originalText.indexOf("\\'") !== -1;
      const hasStringConcat = originalText.includes("' + '");

      if (hasEscapedNewlines || hasEscapedQuotes || hasStringConcat) {
        console.warn('⚠️ [PARSING] originalText contains escaped characters - parsing...', {
          rawOriginalText: originalText.substring(0, 200),
          hasEscapedNewlines,
          hasEscapedQuotes,
          hasStringConcat,
        });

        // Remove string concatenation: ' + '
        let parsedText = originalText.replace(/'\s*\+\s*'/g, '');

        // Remove quotes at start/end if present (e.g., "text" -> text)
        parsedText = parsedText.replace(/^["']|["']$/g, '');

        // Unescape special characters
        parsedText = parsedText.replace(/\\n/g, '\n'); // \n -> actual newline

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
      } else {
        const normalizedText = normalizeForComparison(originalText);
        if (normalizedText !== originalText) {
          console.warn('⚠️ [NORMALIZATION] Applied normalizeForComparison() without detection:', {
            before: originalText.substring(0, 100),
            after: normalizedText.substring(0, 100),
          });
          originalText = normalizedText;
          cachedSelection = {
            ...cachedSelection,
            originalText: normalizedText,
          };
        }
      }

      const allOccurrences = originalContent.split(originalText).length - 1;
      if (allOccurrences > 1) {
        console.warn('⚠️ [MULTIPLE MATCHES] originalText appears multiple times', {
          originalText: originalText.substring(0, 100),
          occurrenceCount: allOccurrences,
          reason: 'originalText is not unique - could match wrong location',
          CRITICAL: 'Refusing to apply update - ambiguous location',
          suggestion: 'originalText should include more context to be unique',
          locationsFound: originalContent
            .split('\n')
            .map((line, idx) => ({ line: idx, contains: line.includes(originalText) }))
            .filter((item) => item.contains)
            .map((item) => `Line ${item.line}`),
        });

        const allLines = originalContent.split('\n');
        const lineLocations = allLines
          .map((lineContent, idx) => ({
            line: idx,
            contains: lineContent.includes(originalText),
            lineContent: lineContent,
            columnIndex: lineContent.indexOf(originalText),
          }))
          .filter((item) => item.contains);
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

        // Extract context for each occurrence
        const locationsWithContext = lineLocations.map((loc) => ({
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
        const exactMatch = lineLocations.find(
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
              console.log(
                '✅ [DISAMBIGUATION - ELEMENT TYPE] Found UNIQUE match with same element type!',
                {
                  elementType: targetLineContext.elementType,
                  foundAtLine: match.line,
                  foundAtColumn: match.columnIndex,
                  specifiedLine: startLine,
                  lineOffset: match.line - startLine,
                  confidence: 'HIGH - only one match with this element type',
                  PROCEEDING: 'Using element-type match',
                },
              );

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
          const nearbyWithColumnMatch = lineLocations.find(
            (loc) =>
              Math.abs(loc.line - startLine) <= 50 && Math.abs(loc.columnIndex - startColumn) <= 2,
          );

          if (nearbyWithColumnMatch && !cachedSelection.startLine) {
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
            const nearbyOccurrence = lineLocations.find(
              (loc) => Math.abs(loc.line - startLine) <= 50,
            );

            if (nearbyOccurrence) {
              console.warn(
                '⚠️ [DISAMBIGUATION - NEARBY ONLY] Found nearby line but column mismatch:',
                {
                  foundAtLine: nearbyOccurrence.line,
                  foundAtColumn: nearbyOccurrence.columnIndex,
                  specifiedLine: startLine,
                  specifiedColumn: startColumn,
                  lineOffset: nearbyOccurrence.line - startLine,
                  columnOffset: nearbyOccurrence.columnIndex - startColumn,
                  WARNING: 'Column position different - may not be exact match',
                  PROCEEDING: 'Using as best guess',
                },
              );
              // Update coordinates
              cachedSelection = {
                ...cachedSelection,
                startLine: nearbyOccurrence.line,
                endLine: nearbyOccurrence.line + (endLine - startLine),
                startColumn: nearbyOccurrence.columnIndex,
                endColumn: nearbyOccurrence.columnIndex + originalText.length,
              };
            } else {
              // STRATEGY 5: No nearby match - find CLOSEST occurrence to specified line (anywhere in file)
              console.warn(
                '⚠️ [DISAMBIGUATION - FALLBACK] No occurrence in ±50 lines - finding CLOSEST match anywhere:',
                {
                  specifiedLine: startLine,
                  searchedRange: `${Math.max(0, startLine - 50)} to ${Math.min(allLines.length - 1, startLine + 50)}`,
                  allOccurrencesAt: lineLocations.map((loc) => loc.line),
                },
              );

              const closestOccurrence = lineLocations.reduce(
                (closest, loc) =>
                  Math.abs(loc.line - startLine) < Math.abs(closest.line - startLine)
                    ? loc
                    : closest,
                lineLocations[0],
              );

        // console.log('✅ [CLOSEST MATCH] Using occurrence nearest to provided coordinates', {
        //   providedLine: startLine,
        //   foundAtLine: closestMatch.line,
        //   foundAtColumn: closestMatch.columnIndex,
        //   lineOffset: closestMatch.line - startLine,
        // });

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

        console.log('🔍 [VALIDATION] Section detection:', {
          originalTextPosition,
          inBody,
          inStyle,
          inScript,
          sections: {
            body: bodyStart !== -1 ? `${bodyStart}-${bodyEnd}` : 'none',
            style: styleStart !== -1 ? `${styleStart}-${styleEnd}` : 'none',
            script: scriptStart !== -1 ? `${scriptStart}-${scriptEnd}` : 'none',
          },
        });

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

      console.log('🔍 [VALIDATION] Text comparison:', {
        expectedOriginalText: cachedSelection.originalText.substring(0, 200),
        currentTextAtLocation: currentTextAtLocation.substring(0, 200),
        expectedLength: cachedSelection.originalText.length,
        currentLength: currentTextAtLocation.length,
        matches: currentTextAtLocation === cachedSelection.originalText,
        startLine,
        endLine,
        startColumn,
        endColumn,
      });

      if (currentTextAtLocation !== cachedSelection.originalText) {
        console.warn(
          '⚠️ [VALIDATION] Text mismatch - searching nearby lines with EXPANDED range...',
          {
            originalStartLine: startLine,
            originalEndLine: endLine,
            searchingRange: `${Math.max(0, startLine - 50)} to ${Math.min(lines.length - 1, endLine + 50)}`,
            mismatchReason: 'Will search ±50 lines to find exact originalText match',
          },
        );

        let foundMatch = false;
        let newStartLine = startLine;
        let newEndLine = endLine;
        let newStartColumn = startColumn;
        let newEndColumn = endColumn;

        // EXPANDED SEARCH: Search in a window of ±30 lines (was ±5)
        // This handles cases where React components or HTML structure has shifted significantly
        const searchWindowStart = Math.max(0, startLine - 50);
        const searchWindowEnd = Math.min(lines.length - 1, endLine + 50);

        for (let searchLine = searchWindowStart; searchLine <= searchWindowEnd; searchLine++) {
          // Try to find the originalText starting at this line
          if (startLine === endLine) {
            // Single-line search
            const line = lines[searchLine] || '';
            const columnIndex = line.indexOf(cachedSelection.originalText);

            if (columnIndex !== -1) {
              newStartLine = searchLine;
              newEndLine = searchLine;
              newStartColumn = columnIndex;
              newEndColumn = columnIndex + cachedSelection.originalText.length;
              foundMatch = true;

              console.log('✅ [VALIDATION] Found originalText at different location!', {
                originalLine: startLine,
                foundAtLine: searchLine,
                lineOffset: searchLine - startLine,
                originalColumn: startColumn,
                foundAtColumn: columnIndex,
                columnOffset: columnIndex - startColumn,
              });
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

              // Verify extraction
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
                console.log(
                  '✅ [VALIDATION] Found multi-line originalText at different location!',
                  {
                    originalStartLine: startLine,
                    foundAtLine: newStartLine,
                    lineOffset: newStartLine - startLine,
                    verified: true,
                  },
                );
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
          cachedSelection = {
            ...cachedSelection,
            startLine: newStartLine,
            endLine: newEndLine,
            startColumn: newStartColumn,
            endColumn: newEndColumn,
          };

          // Re-extract with corrected positions
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

          // UNIFIED INTELLIGENT FUZZY MATCHER
          // Consolidates all fuzzy matching strategies into one intelligent system
          const intelligentFuzzyMatch = (
            line: string,
            searchLine: number,
            originalText: string,
          ):
            | { found: false }
            | {
                found: true;
                startLine: number;
                endLine: number;
                startColumn: number;
                endColumn: number;
                matchType: string;
                needsMultiLineExtension?: boolean;
              } => {
            // Strategy 1: Exact match (fastest)
            const exactMatch = line.indexOf(originalText);
            if (exactMatch !== -1) {
              return {
                found: true,
                startLine: searchLine,
                endLine: searchLine,
                startColumn: exactMatch,
                endColumn: exactMatch + originalText.length,
                matchType: 'EXACT',
              };
              }
              
            // Only apply fuzzy matching for strings >= 15 characters
            if (originalText.trim().length < 15) {
              return { found: false };
            }

            const trimmedOriginal = originalText.trim();
            const normalizedOriginal = normalizeForComparison(trimmedOriginal);

            // Strategy 2: Normalized match (handles quotes/escaping)
            const normalizedLine = normalizeForComparison(line);
            const normalizedMatch = normalizedLine.indexOf(normalizedOriginal);
            if (normalizedMatch !== -1) {
              const startCol = line.indexOf(line.trim());
              return {
                found: true,
                startLine: searchLine,
                endLine: searchLine,
                startColumn: startCol,
                endColumn: line.length,
                matchType: 'NORMALIZED',
              };
            }

            // Strategy 3: Prefix match (handles truncated text)
            if (trimmedOriginal.length >= 20 && line.trim().startsWith(trimmedOriginal)) {
              const startCol = line.indexOf(line.trim());
              return {
                found: true,
                startLine: searchLine,
                endLine: searchLine,
                startColumn: startCol,
                endColumn: line.length,
                matchType: 'PREFIX',
              };
              }

            // Strategy 4: Contains match (handles partial attribute values)
            if (trimmedOriginal.length >= 20 && line.includes(trimmedOriginal)) {
              const matchIndex = line.indexOf(trimmedOriginal);
              let endColumn = matchIndex + trimmedOriginal.length;

              // Extend to closing quote if this is an attribute
                  const attributeMatch = trimmedOriginal.match(/^(\w+)="(.*)$/);
                  if (attributeMatch) {
                const afterMatch = line.substring(endColumn);
                const closingQuote = afterMatch.indexOf('"');
                if (closingQuote !== -1) {
                  endColumn += closingQuote + 1;
                    }
                  }

              return {
                found: true,
                startLine: searchLine,
                endLine: searchLine,
                startColumn: matchIndex,
                endColumn: endColumn,
                matchType: 'CONTAINS',
              };
            }

            const endsWithQuote = trimmedOriginal.endsWith('"');
            const hasAttributePattern = /(\w+)="[^"]*"$/.test(trimmedOriginal);
            if (endsWithQuote && hasAttributePattern) {
              const attrMatch = trimmedOriginal.match(/(\w+)="([^"]*)"$/);
              if (attrMatch) {
                const [, attrName, partialValue] = attrMatch;
                const attrPattern = new RegExp(
                  `${attrName}="[^"]*${partialValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"`,
                );
                const match = line.match(attrPattern);
                if (match && match.index !== undefined) {
                  return {
                    found: true,
                    startLine: searchLine,
                    endLine: searchLine,
                    startColumn: match.index,
                    endColumn: match.index + match[0].length,
                    matchType: 'TRUNCATED_ATTR',
                  };
                }
              }
            }

            // Strategy 6: CSS class pattern match (handles partial CSS classes)
            const cssPattern =
              /(bg-\w+-\d+|text-\w+|hover:\S+|rounded-\w+|shadow\w*|transition|font-\w+|py-\d+|px-\d+|opacity-\d+)/g;
            const originalClasses = trimmedOriginal.match(cssPattern);
            if (originalClasses && originalClasses.length >= 2) {
              const normalizedOrigClasses = originalClasses.map((c) =>
                c
                  .replace(/^hover:/, '')
                  .replace(/"/g, '')
                  .trim(),
              );
              const lineClasses = line.match(cssPattern);
              if (lineClasses && lineClasses.length >= normalizedOrigClasses.length) {
                const normalizedLineClasses = lineClasses.map((c) =>
                  c
                    .replace(/^hover:/, '')
                    .replace(/"/g, '')
                    .trim(),
                );
                let matchCount = 0;
                for (const origClass of normalizedOrigClasses) {
                if (
                    normalizedLineClasses.some(
                      (lc) => lc.includes(origClass) || origClass.includes(lc),
                    )
                  ) {
                    matchCount++;
                  }
                }
                if (matchCount / normalizedOrigClasses.length >= 0.7) {
                  const ternaryMatch = line.match(/[?:]\s*"([^"]*)"/);
                  if (ternaryMatch && ternaryMatch.index !== undefined) {
                    // Found a ternary with quoted string containing CSS classes
                    const matchStart = ternaryMatch.index;
                    const matchEnd = matchStart + ternaryMatch[0].length;

                    return {
                      found: true,
                      startLine: searchLine,
                      endLine: searchLine,
                      startColumn: matchStart,
                      endColumn: matchEnd,
                      matchType: 'CSS_PARTIAL',
                    };
                  }

                  // Fallback: className attribute
                  const classStart = line.indexOf('className=');
                  if (classStart !== -1) {
                    return {
                      found: true,
                      startLine: searchLine,
                      endLine: searchLine,
                      startColumn: classStart,
                      endColumn: line.length,
                      matchType: 'CSS_PARTIAL',
                      needsMultiLineExtension: true,
                    };
                  }
                }
              }
            }

            // Strategy 7: Template literal pattern match (handles malformed templates)
            const looksLikeTemplate =
                  (trimmedOriginal.includes('${') || trimmedOriginal.includes('`')) &&
                  (trimmedOriginal.includes('\\n') || trimmedOriginal.includes('\\"'));
            if (looksLikeTemplate && trimmedOriginal.length >= 30) {
              let coreContent = trimmedOriginal
                .replace(/^["']|["']$/g, '')
                .replace(/\\n[`}]+["']?$/g, '');
              coreContent = coreContent.replace(/\\n/g, '\n').replace(/\\"/g, '"');

              const patterns: string[] = [];
                  const comparisonMatch = coreContent.match(/(\w+)\s*===\s*["']([^"']+)["']/);
              if (comparisonMatch)
                patterns.push(`${comparisonMatch[1]}\\s*===\\s*["']${comparisonMatch[2]}["']`);

                  const includesMatch = coreContent.match(
                    /["']([^"']*)['"]\s*\.\s*includes\s*\(\s*(\w+)\s*\)/,
                  );
              if (includesMatch)
                patterns.push(
                  `["']${includesMatch[1]}["']\\s*\\.\\s*includes\\s*\\(\\s*${includesMatch[2]}\\s*\\)`,
                );

                  const cssMatch = coreContent.match(/(bg-\w+-\d+|text-\w+)/g);
              if (cssMatch && cssMatch.length >= 2) patterns.push(cssMatch.slice(0, 2).join('.*'));

              if (patterns.length >= 2) {
                const combinedPattern = new RegExp(patterns.join('.*'), 'i');
                if (combinedPattern.test(line)) {
                      const classNameStart = line.indexOf('className=');
                      if (classNameStart !== -1) {
                    return {
                      found: true,
                      startLine: searchLine,
                      endLine: searchLine,
                      startColumn: classNameStart,
                      endColumn: line.length,
                      matchType: 'TEMPLATE_PATTERN',
                      needsMultiLineExtension: true,
                    };
                  }
                }
              }
            }

            return { found: false };
          };

          // Try to find it anywhere in the file using intelligent fuzzy matching
          for (let searchLine = 0; searchLine < lines.length; searchLine++) {
            if (cachedSelection.originalText.indexOf('\n') === -1) {
              // Single-line text
              const line = lines[searchLine];
              const matchResult = intelligentFuzzyMatch(
                line,
                searchLine,
                cachedSelection.originalText,
              );

              if (matchResult.found) {
                globalStartLine = matchResult.startLine;
                globalEndLine = matchResult.endLine;
                globalStartColumn = matchResult.startColumn;
                globalEndColumn = matchResult.endColumn;

                // Handle multi-line extensions for CSS/template patterns
                if (matchResult.needsMultiLineExtension) {
                  // Search forward to find closing bracket/backtick
                  for (
                    let endSearchLine = searchLine;
                    endSearchLine < Math.min(searchLine + 15, lines.length);
                    endSearchLine++
                  ) {
                    const endLine = lines[endSearchLine];
                    const closingIndex = endLine.search(/[`})\]]/);
                    if (closingIndex !== -1) {
                      globalEndLine = endSearchLine;
                      globalEndColumn = closingIndex + 1;
                      break;
                    }
                  }
                }

                globalFoundMatch = true;
                console.log(
                  `✅ [INTELLIGENT FUZZY MATCH - ${matchResult.matchType}] Found at line ${searchLine}`,
                );
                break;
              }
              // All fuzzy matching logic is now handled by intelligentFuzzyMatch above
            } else {
              const normalizedOriginalText = normalizeForComparison(cachedSelection.originalText);
              const textLines = normalizedOriginalText.split('\n');
              const searchEndLine = Math.min(lines.length - 1, searchLine + textLines.length - 1);

              // Build potential match
              const potentialLines = lines.slice(searchLine, searchEndLine + 1);
              const potentialMatch = potentialLines.join('\n');

              if (potentialMatch === normalizedOriginalText) {
                // Exact match found
                globalStartLine = searchLine;
                globalEndLine = searchEndLine;
                globalStartColumn = 0;
                globalEndColumn = lines[searchEndLine].length;
                globalFoundMatch = true;
                console.log(
                  '[GLOBAL SEARCH] Found multi-line originalText starting at line',
                  searchLine,
                );
                break;
              } else if (potentialMatch.includes(normalizedOriginalText)) {
                // Text found but need to calculate exact position
                const matchStart = potentialMatch.indexOf(normalizedOriginalText);
                const beforeMatch = potentialMatch.substring(0, matchStart);
                const newlinesBefore = (beforeMatch.match(/\n/g) || []).length;

                globalStartLine = searchLine + newlinesBefore;
                globalStartColumn = matchStart - beforeMatch.lastIndexOf('\n') - 1;
                if (globalStartColumn < 0) globalStartColumn = matchStart;

                const textLineCount = textLines.length;
                if (textLineCount === 1) {
                  globalEndLine = globalStartLine;
                  globalEndColumn = globalStartColumn + normalizedOriginalText.length;
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

                if (extracted === normalizedOriginalText) {
                  globalFoundMatch = true;
                  console.log(
                    '✅ [GLOBAL SEARCH] Found originalText with calculated coordinates at line',
                    globalStartLine,
                  );
                  break;
                }
              }

              // FUZZY MATCH for multi-line: Check if first line starts with originalText first line
              // Require at least 20 characters in the first line to ensure uniqueness
              if (!globalFoundMatch && normalizedOriginalText.trim().length >= 20) {
                const originalFirstLine = textLines[0].trim();
                const actualFirstLine = lines[searchLine]?.trim() || '';

                if (
                  actualFirstLine.length > 0 &&
                  originalFirstLine.length >= 20 &&
                  actualFirstLine.startsWith(originalFirstLine)
                ) {
                  // Found a fuzzy match - use full lines
                  globalStartLine = searchLine;
                  globalEndLine = Math.min(lines.length - 1, searchLine + textLines.length - 1);
                  globalStartColumn = 0;
                  globalEndColumn = lines[globalEndLine]?.length || 0;
                  globalFoundMatch = true;
                  console.log(
                    '[FUZZY MULTI-LINE SEARCH] Found multi-line text starting with originalText at line',
                    searchLine,
                    {
                      originalFirstLineLength: originalFirstLine.length,
                      actualFirstLineLength: actualFirstLine.length,
                      match: 'PREFIX',
                      expectedLines: textLines.length,
                      minimumLength: 20,
                    },
                  );
                  break;
              }

                // FUZZY MATCH 2 for multi-line: Normalize and compare
                const normalizedOriginalFirstLine = normalizeForComparison(originalFirstLine);
                const normalizedActualFirstLine = normalizeForComparison(actualFirstLine);

                if (
                  actualFirstLine.length > 0 &&
                  normalizedOriginalFirstLine.length >= 20 &&
                  (normalizedActualFirstLine.startsWith(normalizedOriginalFirstLine) ||
                    normalizedActualFirstLine.includes(normalizedOriginalFirstLine))
                ) {
                  // Found a normalized fuzzy match
                  globalStartLine = searchLine;
                  globalEndLine = Math.min(lines.length - 1, searchLine + textLines.length - 1);
                  globalStartColumn = 0;
                  globalEndColumn = lines[globalEndLine]?.length || 0;
                  globalFoundMatch = true;
                  console.log(
                    '✅ [FUZZY MULTI-LINE SEARCH - NORMALIZED] Found multi-line text with normalized match at line',
                    searchLine,
                    {
                      originalFirstLine: originalFirstLine.substring(0, 50),
                      normalizedOriginalFirstLine: normalizedOriginalFirstLine.substring(0, 50),
                      actualFirstLine: actualFirstLine.substring(0, 50),
                      normalizedActualFirstLine: normalizedActualFirstLine.substring(0, 50),
                      match: 'NORMALIZED',
                      expectedLines: textLines.length,
                    },
                  );
                  break;
                }
              }
            }
          }

          if (globalFoundMatch) {
            // Use the globally found location
            console.log('🌍 [GLOBAL SEARCH SUCCESS] Found originalText - using actual location:', {
              providedCoordinates: { startLine, endLine, startColumn, endColumn },
              actualLocation: {
                startLine: globalStartLine,
                endLine: globalEndLine,
                startColumn: globalStartColumn,
                endColumn: globalEndColumn,
              },
              offset: {
                lines: globalStartLine - startLine,
                message: 'LLM provided coordinates were off - using correct location',
              },
            });

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

            cachedSelection = {
              ...cachedSelection,
              startLine: globalStartLine,
              endLine: globalEndLine,
              startColumn: globalStartColumn,
              endColumn: globalEndColumn,
              originalText: currentTextAtCoords, // Use the FULL text, not the truncated LLM version
            };

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


            // If the text at coordinates is identical to updateContent, skip the update
            if (currentTextAtCoords === updateContent) {
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
        // Non-sequential mode and text matches exactly
        console.log('✅ [VALIDATION PASSED] Original text matches - safe to apply update');
      }
    } // END: LLM validation block (cachedSelection.source !== 'user')
  } else {
    console.warn('⚠️ [VALIDATION SKIPPED] No originalText in selection context');
  }

  // Re-extract line/column numbers (may have been corrected above)
  // NOTE: Using 'let' instead of 'const' because these may be updated if pre-merge validation finds incomplete coordinates
  let finalStartLine = cachedSelection.startLine;
  let finalEndLine = cachedSelection.endLine;
  let finalStartColumn = cachedSelection.startColumn;
  let finalEndColumn = cachedSelection.endColumn;

  if (cachedSelection?.originalText && cachedSelection.source !== 'user') {
    let extractedAtCoordinates = '';

    if (finalStartLine === finalEndLine) {
      extractedAtCoordinates = lines[finalStartLine]?.slice(finalStartColumn, finalEndColumn) || '';
    } else {
      const firstPart = lines[finalStartLine]?.slice(finalStartColumn) || '';
      const lastPart = lines[finalEndLine]?.slice(0, finalEndColumn) || '';
      const middleParts = lines.slice(finalStartLine + 1, finalEndLine);
      extractedAtCoordinates = [firstPart, ...middleParts, lastPart].join('\n');
    }

    // Normalize for comparison
    const normalizeText = (text: string) =>
      text
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n');
    const normalizedExtracted = normalizeText(extractedAtCoordinates);
    const normalizedOriginal = normalizeText(cachedSelection.originalText);

    if (normalizedExtracted !== normalizedOriginal) {
      const fullTextIndex = originalContent.indexOf(cachedSelection.originalText);

      if (fullTextIndex !== -1) {
        // Found complete text! Recalculate coordinates
        const textBefore = originalContent.substring(0, fullTextIndex);
        const newStartLine = textBefore.split('\n').length - 1;
        const lineStartIndex = textBefore.lastIndexOf('\n') + 1;
        const newStartColumn = fullTextIndex - lineStartIndex;

        const originalTextLines = cachedSelection.originalText.split('\n');
        const newEndLine = newStartLine + originalTextLines.length - 1;
        const newEndColumn =
          originalTextLines.length === 1
            ? newStartColumn + cachedSelection.originalText.length
            : originalTextLines[originalTextLines.length - 1].length;
        // Update coordinates
        finalStartLine = newStartLine;
        finalEndLine = newEndLine;
        finalStartColumn = newStartColumn;
        finalEndColumn = newEndColumn;

        // Also update cachedSelection for consistency
        cachedSelection = {
          ...cachedSelection,
          startLine: newStartLine,
          endLine: newEndLine,
          startColumn: newStartColumn,
          endColumn: newEndColumn,
        };
      } else {
        console.error('❌ [PRE-MERGE FATAL] originalText NOT FOUND anywhere in document!', {
          originalText: cachedSelection.originalText.substring(0, 300),
          REFUSING: 'Cannot proceed - text does not exist in artifact',
        });
        return originalContent;
      }
    }
  }

      if (finalStartLine === finalEndLine) {
        console.log('📍 [SINGLE-LINE PATH] Entering single-line merge logic');
        // Single-line selection: replace only the substring
        const line = lines[finalStartLine] || '';
        let before = line.slice(0, finalStartColumn);
        const after = line.slice(finalEndColumn);

        const selectedText = line.slice(finalStartColumn, finalEndColumn);
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
      // contains complete code (not a continuation), the update is likely a full replacement
      if (before.trim() === '' && firstUpdateLineTrimmed.length > 10) {
        // Check if the current line (with 'before' + what we're replacing) forms complete code
        const currentLineComplete = line.trim();
        // Check if first update line could be the start of that same code
        if (
          currentLineComplete.length > 0 &&
          firstUpdateLineTrimmed.substring(0, 20) === currentLineComplete.substring(0, 20)
        ) {
          console.error('🚨 FULL LINE REPLACEMENT DETECTED!', {
            beforeIsIndentation: `"${before}"`,
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
      const firstLine = before + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + after;
      const middleLines = updateLines.slice(1, -1);


      const newLines = [
        ...lines.slice(0, finalStartLine),
        firstLine,
        ...middleLines,
        lastLine,
        ...lines.slice(finalStartLine + 1),
      ];

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


      return finalResult;
    }

    lines[finalStartLine] = before + updateContent + after;
    const result = lines.join('\n');

    const sanitizedResult = _sanitizeMergeResult(result);

    return sanitizedResult;
  } else {

    // 🔍 SHOW WHAT'S ACTUALLY AT THESE COORDINATES
    const lineAtStart = lines[finalStartLine] || '';
    const textAtCoordinates =
      finalStartLine === finalEndLine
        ? lineAtStart.slice(finalStartColumn, finalEndColumn)
        : (() => {
            const firstPart = lineAtStart.slice(finalStartColumn);
            const lastPart = lines[finalEndLine]?.slice(0, finalEndColumn) || '';
            const middleParts = lines.slice(finalStartLine + 1, finalEndLine);
            return [firstPart, ...middleParts, lastPart].join('\n');
          })();

    console.log('🔍🔍🔍 [COORDINATE EXTRACTION] What text exists at these coordinates:', {
      fullLine: lineAtStart,
      beforeColumn: lineAtStart.slice(0, finalStartColumn),
      extractedText: textAtCoordinates,
      afterColumn:
        finalStartLine === finalEndLine ? lineAtStart.slice(finalEndColumn) : 'multi-line',
      ISSUE_CHECK: {
        beforeContainsOpeningTag: /<\w+/.test(lineAtStart.slice(0, finalStartColumn)),
        extractedStartsWith: textAtCoordinates.substring(0, 20),
        expectedStartsWith: cachedSelection?.originalText?.substring(0, 20) || 'N/A',
        MISMATCH:
          textAtCoordinates.substring(0, 20) !==
          (cachedSelection?.originalText?.substring(0, 20) || ''),
      },
    });

    const firstLineLength = lines[finalStartLine]?.length || 0;
    const lastLineLength = lines[finalEndLine]?.length || 0;

    // Check if columns span most of the line (>90% or starts at 0)
    const firstLineIsFullySelected =
      finalStartColumn === 0 || finalStartColumn < firstLineLength * 0.1;
    const lastLineIsFullySelected =
      finalEndColumn >= lastLineLength * 0.9 || finalEndColumn === lastLineLength;

    const shouldReplaceFullLines = firstLineIsFullySelected && lastLineIsFullySelected;

    let beforeStart: string;
    let afterEnd: string;
    let before: string[];
    let after: string[];

    if (shouldReplaceFullLines) {
      // FULL LINE REPLACEMENT - ignore column coordinates entirely
      console.log('✅ [FULL LINE MODE] Replacing complete lines - ignoring column coordinates');
      beforeStart = ''; // No partial line at start
      afterEnd = ''; // No partial line at end
      before = lines.slice(0, finalStartLine);
      after = lines.slice(finalEndLine + 1);
    } else {
      // COLUMN-BASED REPLACEMENT - use exact coordinates
      console.log('✅ [COLUMN MODE] Using precise column coordinates for partial line replacement');
      beforeStart = lines[finalStartLine]?.slice(0, finalStartColumn) || '';
      afterEnd = lines[finalEndLine]?.slice(finalEndColumn) || '';
      before = lines.slice(0, finalStartLine);
      after = lines.slice(finalEndLine + 1);
    }

    // Verify that the selected text actually exists across the specified lines
    const firstLineOriginal = lines[finalStartLine] || '';
    const lastLineOriginal = lines[finalEndLine] || '';
    let selectedFirstPart = firstLineOriginal.slice(finalStartColumn);
    let selectedLastPart = lastLineOriginal.slice(0, finalEndColumn);

    // Check if end column is suspiciously small for a multi-line replacement
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
      return originalContent;
    }

    // Validate last line with CORRECTED values (CRITICAL FIX!)
    const lastLineReconstructed = finalSelectedLastPart + finalAfterEnd;
    if (lastLineReconstructed !== lastLineOriginal) {
      return originalContent;
    }

    if (cachedSelection?.originalText) {
      let extractedAtCoordinates = '';

      if (finalStartLine === finalEndLine) {
        extractedAtCoordinates =
          lines[finalStartLine]?.slice(finalStartColumn, finalEndColumn) || '';
      } else {
        const firstPart = lines[finalStartLine]?.slice(finalStartColumn) || '';
        const lastPart = lines[finalEndLine]?.slice(0, finalEndColumn) || '';
        const middleParts = lines.slice(finalStartLine + 1, finalEndLine);
        extractedAtCoordinates = [firstPart, ...middleParts, lastPart].join('\n');
      }

      // Normalize for comparison
      const normalizeText = (text: string) =>
        text
          .split('\n')
          .map((l) => l.trimEnd())
          .join('\n');
      const normalizedExtracted = normalizeText(extractedAtCoordinates);
      const normalizedOriginal = normalizeText(cachedSelection.originalText);

      if (normalizedExtracted !== normalizedOriginal) {
        console.error(
          '🚨 [PRE-MERGE CRITICAL] Extracted text does NOT match complete originalText!',
          {
            extractedLength: extractedAtCoordinates.length,
            expectedLength: cachedSelection.originalText.length,
            extractedFirstLine: extractedAtCoordinates.split('\n')[0],
            expectedFirstLine: cachedSelection.originalText.split('\n')[0],
            extractedPreview: extractedAtCoordinates.substring(0, 200),
            expectedPreview: cachedSelection.originalText.substring(0, 200),
            PROBLEM: 'Coordinates are INCOMPLETE - missing beginning or end of element',
            FIX: 'Searching entire document for COMPLETE originalText',
          },
        );

        // FORCE FULL DOCUMENT SEARCH for complete originalText
        const fullTextIndex = originalContent.indexOf(cachedSelection.originalText);

        if (fullTextIndex !== -1) {
          // Found complete text! Recalculate coordinates
          const textBefore = originalContent.substring(0, fullTextIndex);
          const newStartLine = textBefore.split('\n').length - 1;
          const lineStartIndex = textBefore.lastIndexOf('\n') + 1;
          const newStartColumn = fullTextIndex - lineStartIndex;

          const originalTextLines = cachedSelection.originalText.split('\n');
          const newEndLine = newStartLine + originalTextLines.length - 1;
          const newEndColumn =
            originalTextLines.length === 1
              ? newStartColumn + cachedSelection.originalText.length
              : originalTextLines[originalTextLines.length - 1].length;

          cachedSelection = {
            ...cachedSelection,
            startLine: newStartLine,
            endLine: newEndLine,
            startColumn: newStartColumn,
            endColumn: newEndColumn,
          };


          // Update all the coordinate variables to match corrected values
          finalStartLine = newStartLine;
          finalEndLine = newEndLine;
          finalStartColumn = newStartColumn;
          finalEndColumn = newEndColumn;
          correctedEndColumn = newEndColumn;

          // Recalculate beforeStart, afterEnd, before, and after using corrected coordinates
          beforeStart = lines[finalStartLine]?.slice(0, finalStartColumn) || '';
          const newAfterEnd = lines[finalEndLine]?.slice(finalEndColumn) || '';
          before = lines.slice(0, finalStartLine);
          after = lines.slice(finalEndLine + 1);

          // Update the corrected values
          afterEnd = newAfterEnd;
          correctedAfterEnd = newAfterEnd;
          selectedFirstPart = lines[finalStartLine]?.slice(finalStartColumn) || '';
          selectedLastPart = lines[finalEndLine]?.slice(0, finalEndColumn) || '';
          correctedSelectedLastPart = selectedLastPart;
        } else {
          console.error('❌ [PRE-MERGE FATAL] originalText NOT FOUND anywhere in document!', {
            originalText: cachedSelection.originalText.substring(0, 300),
            REFUSING: 'Cannot proceed - text does not exist in artifact',
          });
          return originalContent;
        }
      }
    }

    const selectedTextForDeletion =
      finalStartLine === finalEndLine
        ? lines[finalStartLine]?.slice(finalStartColumn, correctedEndColumn) || ''
        : (() => {
            const firstPart = lines[finalStartLine]?.slice(finalStartColumn) || '';
            const lastPart = lines[finalEndLine]?.slice(0, correctedEndColumn) || '';
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

    // Check for bracket mismatches that might indicate wrong coordinates
    const openingTagsInDeleted = selectedTextForDeletion.match(/<[\w-]+[^/>]*>/g) || [];
    const openingTagsInUpdate = updateContent.match(/<[\w-]+[^/>]*>/g) || [];

    const isFullLineSelection =
      finalStartColumn === 0 &&
      (finalAfterEnd.trim() === '' || correctedEndColumn === (lines[finalEndLine]?.length || 0));

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
      console.log('✅ Full line selection detected - using update content directly');
      mergedUpdateLines = updateLines;
    } else if (updateLines.length === 1) {
      // Single update line replaces the whole region - add prefix and suffix
      console.log('✅ Single-line replacement in multi-line selection');
      mergedUpdateLines = [effectiveBeforeStart + updateLines[0] + finalAfterEnd];
    } else {
      const firstLine = effectiveBeforeStart + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + finalAfterEnd;

      mergedUpdateLines = [firstLine, ...updateLines.slice(1, -1), lastLine];

      console.log('✅ Multi-line merge complete:', {
        updateLinesCount: updateLines.length,
        beforeStart: `"${beforeStart}"`,
        effectiveBeforeStart: `"${effectiveBeforeStart}"`,
        afterEnd: `"${finalAfterEnd}"`,
        originalAfterEnd: afterEnd !== finalAfterEnd ? `"${afterEnd}"` : '(same)',
        wasAutoCorrected: afterEnd !== finalAfterEnd,
        firstLine: `"${firstLine}"`,
        middleLinesCount: updateLines.slice(1, -1).length,
        lastLine: `"${lastLine}"`,
        totalMergedLines: mergedUpdateLines.length,
        mergedUpdateLinesPreview: mergedUpdateLines.slice(0, 3),
      });
    }

    const finalMergedUpdateLines = [...mergedUpdateLines];


    const mergedContent = [...before, ...finalMergedUpdateLines, ...after].join('\n');

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
  const callStack = new Error().stack;
  const callSite = callStack?.split('\n')[2]?.trim() || 'UNKNOWN';

  console.log(
    '🚀🚀🚀 [applyAllPartialUpdates] ==================== ENTRY POINT ====================',
  );
  console.log('🚀🚀🚀 [applyAllPartialUpdates] CALLED FROM:', callSite);
  console.log('🚀🚀🚀 [applyAllPartialUpdates] PARAMETERS:', {
    originalContentIsNull: originalContent === null,
    originalContentIsUndefined: originalContent === undefined,
    originalContentIsEmpty: originalContent === '',
    originalContentType: typeof originalContent,
    originalContentLength: originalContent?.length || 0,
    originalContentPreview: originalContent?.substring(0, 150) || 'EMPTY/NULL',
    artifactsCount: artifacts ? Object.keys(artifacts).length : 0,
    targetArtifactId,
    isStreaming,
    allArtifactIds: artifacts ? Object.keys(artifacts) : [],
    HAS_DUPLICATION: originalContent
      ? (originalContent.match(/<!DOCTYPE/gi) || []).length > 1 ||
        (originalContent.match(/<html/gi) || []).length > 1
      : false,
    doctypeCount: originalContent ? (originalContent.match(/<!DOCTYPE/gi) || []).length : 0,
    htmlCount: originalContent ? (originalContent.match(/<html/gi) || []).length : 0,
  });
  if (!artifacts) {
    console.warn('⚠️ [applyAllPartialUpdates] No artifacts provided, returning original content');
    return originalContent;
  }

  const targetArtifact = targetArtifactId ? artifacts[targetArtifactId] : null;
  const targetTime = targetArtifact?.lastUpdateTime || Infinity;
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
      mergedContent = baseArtifact.content;
    } else {
      console.error('❌ [applyAllPartialUpdates] Could not find clean base artifact!');
      // Return a safe fallback - empty or minimal content
      // This prevents the duplication from propagating
      return ''; // Or return some minimal safe content
    }
  }
  // Don't try to split it - just use it directly
  const targetBaseIdentifier = targetArtifact?.identifier;

  // If viewing BASE artifact (not an update), targetIndex = -1 (no updates applied)
  // If viewing UPDATE artifact, targetIndex = that update's index (apply updates 0 through targetIndex)
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
      if (timeA !== timeB) {
        return timeA - timeB; // ASCENDING: earlier updates first
      }

      // If times are equal, sort by index
      return indexA - indexB; // ASCENDING: lower index first
    });

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
  const baseContent = mergedContent; // Store the original base content for logging

  for (const updateArtifact of updateArtifacts) {

    const newContent = applyPartialUpdate(
      mergedContent, // Build on previous updates sequentially
      updateArtifact.content, // Apply this update's content
      updateArtifact.id,
      count,
      artifacts,
      false,
    );

    if (newContent !== mergedContent) {
      mergedContent = newContent;
    } else {
      console.log('⏭️  Content unchanged, skipping');
    }
    count++;
  }

  if (targetArtifactId && mergedContent !== originalContent) {
    const targetArtifact = artifacts[targetArtifactId];
    if (targetArtifact && targetArtifact.isUpdate) {
      console.log('mergedContent', mergedContent);
      artifactCache.setContent(targetArtifactId, mergedContent, {
        title: targetArtifact.title,
        type: targetArtifact.type,
        identifier: targetArtifact.identifier,
        source: 'directive',
        conversationId: conversationId || undefined,
      });
    }
  } else if (isStreaming) {
    console.log('⏸️ Skipping final cache save during streaming');
  }

  // 🔍 FINAL CHANGE DETECTION: Show exactly what changed
  _logContentChanges(originalContent, mergedContent, targetArtifact?.title || 'unknown');

  return mergedContent;
}

/**
 * Helper function to detect and log the exact changes between original and merged content
 * This helps diagnose corruption issues by showing what actually changed
 */
function _logContentChanges(originalContent: string, mergedContent: string, artifactTitle: string) {
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
}
