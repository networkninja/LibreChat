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

  // CRITICAL FIX: Detect and fix malformed style attributes
  // Pattern: style="value1">"value2">
  const malformedStylePattern = /(style\s*=\s*"[^"]*")>"[^"]*">/g;
  if (malformedStylePattern.test(fixed)) {
    console.warn('🧹 [SANITIZE] Detected malformed style - fixing...');
    fixed = fixed.replace(malformedStylePattern, (_match, capture) => {
      console.log('  Fixed:', _match, '→', capture + '>');
      return capture + '>';
    });
  }

  // CRITICAL FIX: Detect and fix malformed id/data attributes
  // Pattern: id="value1">"value2"> or data-*="value1">"value2">
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

  // Get leading whitespace from first line of both texts
  const getLeadingWhitespace = (text: string) => {
    const firstLine = text.split('\n')[0];
    const match = firstLine.match(/^(\s*)/);
    return match ? match[1] : '';
  };

  const originalLeadingWS = getLeadingWhitespace(originalContent);
  const updateLeadingWS = getLeadingWhitespace(updateContent);

  // If indentation differs, normalize updateContent to match originalContent's indentation
  let normalizedUpdateContent = updateContent;
  if (originalLeadingWS !== updateLeadingWS && originalLeadingWS.length > 0) {
    // Remove updateContent's leading whitespace and replace with originalContent's
    const updateLines = updateContent.split('\n');
    const normalizedLines = updateLines.map((line, index) => {
      // Only adjust first line's indentation to match
      if (index === 0 && line.startsWith(updateLeadingWS)) {
        return originalLeadingWS + line.substring(updateLeadingWS.length);
      }
      return line;
    });
    normalizedUpdateContent = normalizedLines.join('\n');

    console.log('🔧 [applyPartialUpdate] Normalized indentation mismatch:', {
      originalLeadingWS: JSON.stringify(originalLeadingWS),
      updateLeadingWS: JSON.stringify(updateLeadingWS),
      originalFirstLine: originalContent.split('\n')[0].substring(0, 50),
      updateFirstLine: updateContent.split('\n')[0].substring(0, 50),
      normalizedFirstLine: normalizedUpdateContent.split('\n')[0].substring(0, 50),
      FIX: 'Adjusted updateContent indentation to match originalContent',
    });
  }

  // Now trim trailing whitespace only (preserve leading for proper merging)
  const trimmedUpdateContent = normalizedUpdateContent.trimEnd();

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
  const startLine = cachedSelection.startLine;
  const endLine = cachedSelection.endLine;
  const startColumn = cachedSelection.startColumn;
  const endColumn = cachedSelection.endColumn;
  const lines = originalContent.split('\n');
  if (typeof updateContent === 'undefined') return originalContent;

  const updateLines = updateContent.split('\n');

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

      // SIMPLE APPROACH: If originalText appears multiple times, find the one closest to the provided line number
      const allOccurrences = originalContent.split(originalText).length - 1;
      if (allOccurrences > 1) {
        console.warn('⚠️ [MULTIPLE MATCHES] originalText appears multiple times', {
          originalText: originalText.substring(0, 100),
          occurrenceCount: allOccurrences,
          providedLine: startLine,
          action: 'Will use the occurrence closest to the provided line number',
        });

        const allLines = originalContent.split('\n');
        const isMultiLine = originalText.includes('\n');
        let lineLocations: Array<{ line: number; columnIndex: number }> = [];

        if (isMultiLine) {
          // Multi-line: find all starting positions
          let searchIndex = 0;
          while (searchIndex < originalContent.length) {
            const foundIndex = originalContent.indexOf(originalText, searchIndex);
            if (foundIndex === -1) break;

            const textBeforeMatch = originalContent.substring(0, foundIndex);
            const lineNumber = textBeforeMatch.split('\n').length - 1;
            const lineStartIndex = textBeforeMatch.lastIndexOf('\n') + 1;
            const columnIndex = foundIndex - lineStartIndex;

            lineLocations.push({ line: lineNumber, columnIndex });
            searchIndex = foundIndex + 1;
          }
        } else {
          // Single-line: check each line
          lineLocations = allLines
            .map((lineContent, idx) => ({
              line: idx,
              columnIndex: lineContent.indexOf(originalText),
            }))
            .filter((loc) => loc.columnIndex !== -1);
        }

        // Find the occurrence CLOSEST to the provided line number
        const closestMatch = lineLocations.reduce((closest, loc) =>
          Math.abs(loc.line - startLine) < Math.abs(closest.line - startLine) ? loc : closest,
        );

        console.log('✅ [CLOSEST MATCH] Using occurrence nearest to provided coordinates', {
          providedLine: startLine,
          foundAtLine: closestMatch.line,
          foundAtColumn: closestMatch.columnIndex,
          lineOffset: closestMatch.line - startLine,
        });

        // Update coordinates to the closest match
        const textLines = originalText.split('\n');
        cachedSelection = {
          ...cachedSelection,
          startLine: closestMatch.line,
          endLine: closestMatch.line + textLines.length - 1,
          startColumn: closestMatch.columnIndex,
          endColumn:
            textLines.length === 1
              ? closestMatch.columnIndex + originalText.length
              : textLines[textLines.length - 1].length,
        };
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

      console.log('🔍 [STRICT VALIDATION] Checking BOTH line numbers AND text content:', {
        step1_lineNumbers: {
          providedStartLine: startLine,
          providedEndLine: endLine,
          lineNumbersValid: startLine >= 0 && endLine < lines.length,
          actualContentAtLines: currentTextAtLocation.substring(0, 200),
        },
        step2_textMatch: {
          expectedText: cachedSelection.originalText.substring(0, 200),
          actualText: currentTextAtLocation.substring(0, 200),
          textMatches: currentTextAtLocation === cachedSelection.originalText,
        },
        step3_bothRequired: {
          lineNumbersValid: startLine >= 0 && endLine < lines.length,
          textMatches: currentTextAtLocation === cachedSelection.originalText,
          BOTH_VALID:
            startLine >= 0 &&
            endLine < lines.length &&
            currentTextAtLocation === cachedSelection.originalText,
        },
      });

      // This is a STRICT validation - we do NOT use fallback search anymore
      // If the LLM provides wrong text, we want to know about it (validation error)
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

      if (currentTextAtLocation !== cachedSelection.originalText) {
        console.warn('⚠️ [FUZZY MATCH] Text mismatch - searching ±100 lines for match...', {
          originalStartLine: startLine,
          originalEndLine: endLine,
          searchingRange: `${Math.max(0, startLine - 100)} to ${Math.min(lines.length - 1, endLine + 100)}`,
        });

        let foundMatch = false;
        let newStartLine = startLine;
        let newEndLine = endLine;
        let newStartColumn = startColumn;
        let newEndColumn = endColumn;

        // Search in a window of ±100 lines
        const searchWindowStart = Math.max(0, startLine - 100);
        const searchWindowEnd = Math.min(lines.length - 1, endLine + 100);
        const isOriginalTextMultiLine = cachedSelection.originalText.includes('\n');

        // Helper function to normalize whitespace for fuzzy matching
        const normalizeWhitespace = (text: string) => {
          return text.replace(/\s+/g, ' ').trim();
        };

        const normalizedOriginalText = normalizeWhitespace(cachedSelection.originalText);

        for (let searchLine = searchWindowStart; searchLine <= searchWindowEnd; searchLine++) {
          if (!isOriginalTextMultiLine) {
            // Single-line: try exact match first, then fuzzy whitespace match
            const line = lines[searchLine] || '';
            let columnIndex = line.indexOf(cachedSelection.originalText);

            // If exact match fails, try whitespace-normalized match
            if (columnIndex === -1) {
              const normalizedLine = normalizeWhitespace(line);
              const fuzzyIndex = normalizedLine.indexOf(normalizedOriginalText);

              if (fuzzyIndex !== -1) {
                // Found fuzzy match - now find the actual position in the original line
                // by counting characters up to the fuzzy match position
                let charCount = 0;
                let actualPos = 0;
                for (let i = 0; i < line.length; i++) {
                  if (line[i].match(/\S/)) {
                    // Non-whitespace character
                    if (charCount === fuzzyIndex) {
                      actualPos = i;
                      break;
                    }
                    charCount++;
                  }
                }
                columnIndex = actualPos;
                console.log(
                  '✅ [FUZZY WHITESPACE MATCH] Found at line',
                  searchLine,
                  'using normalized matching',
                );
              }
            }

            if (columnIndex !== -1) {
              newStartLine = searchLine;
              newEndLine = searchLine;
              newStartColumn = columnIndex;
              newEndColumn = columnIndex + cachedSelection.originalText.length;
              foundMatch = true;
              console.log('✅ [FUZZY MATCH] Found at line', searchLine, 'column', columnIndex);
              break;
            }
          } else {
            // Multi-line: search from this line position
            const searchStartPos =
              lines.slice(0, searchLine).join('\n').length + (searchLine > 0 ? 1 : 0);
            const contentFromHere = originalContent.substring(searchStartPos);
            const matchIndex = contentFromHere.indexOf(cachedSelection.originalText);

            if (matchIndex !== -1) {
              const absoluteMatchStart = searchStartPos + matchIndex;
              const textBeforeMatch = originalContent.substring(0, absoluteMatchStart);
              const lineNumber = textBeforeMatch.split('\n').length - 1;
              const lineStartIndex = textBeforeMatch.lastIndexOf('\n') + 1;
              const columnIndex = absoluteMatchStart - lineStartIndex;

              newStartLine = lineNumber;
              newStartColumn = columnIndex;

              const textLines = cachedSelection.originalText.split('\n');
              newEndLine = newStartLine + textLines.length - 1;
              newEndColumn =
                textLines.length === 1
                  ? columnIndex + cachedSelection.originalText.length
                  : textLines[textLines.length - 1].length;

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
                console.log('✅ [FUZZY MATCH] Found multi-line match at line', newStartLine);
                break;
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
          console.error('❌ [FUZZY MATCH FAILED] Could not find originalText within ±100 lines', {
            searchedLines: `${searchWindowStart} to ${searchWindowEnd}`,
            originalText: cachedSelection.originalText.substring(0, 100),
            decision: 'Using original coordinates as fallback',
          });
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
  const finalStartLine = cachedSelection.startLine;
  const finalEndLine = cachedSelection.endLine;
  const finalStartColumn = cachedSelection.startColumn;
  const finalEndColumn = cachedSelection.endColumn;

  if (finalStartLine === finalEndLine) {
    console.log('📍 [SINGLE-LINE PATH] Entering single-line merge logic');

    // 🚨 CRITICAL: Check for invalid column coordinates (both 0)
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

    // we need to handle it as a multi-line replacement
    // NOTE: updateLines is already declared at line 649, don't redeclare it here
    console.log('updateLinesLength', updateLines.length);

    // This happens when the first line of updateContent duplicates what's in 'before'
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

      console.log('Multi-line update in single-line selection:', {
        before: `"${before}"`,
        after: `"${after}"`,
        adjustedAfter: `"${adjustedAfter}"`,
        afterWasCleared: adjustedAfter !== after,
        firstLine: `"${firstLine}"`,
        middleLines,
        lastLine: `"${lastLine}"`,
        startLine: startLine,
      });

      const newLines = [
        ...lines.slice(0, finalStartLine),
        firstLine,
        ...middleLines,
        lastLine,
        ...lines.slice(finalStartLine + 1),
      ];

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

    // CRITICAL FIX: Check if updateContent already includes the indentation from 'before'
    // This happens when LLM provides the full replacement including leading whitespace
    let effectiveBefore = before;
    const effectiveUpdateContent = updateContent;

    // Only check if 'before' is pure whitespace (indentation)
    if (before.trim() === '' && before.length > 0 && updateContent.length > 0) {
      // Check if updateContent starts with the same whitespace
      if (updateContent.startsWith(before)) {
        effectiveBefore = '';
      } else {
        // Check if updateContent has different indentation
        const updateLeadingWS = updateContent.match(/^(\s*)/)?.[1] || '';
        if (updateLeadingWS.length > 0 && updateLeadingWS !== before) {
          effectiveBefore = '';
        }
      }
    }

    lines[useLine] = effectiveBefore + effectiveUpdateContent + after;
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
        // AUTO-CORRECT: For multi-line element replacements, endColumn should be at end of line
        // This prevents corruption from wrong column coordinates
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
    // Check what we're about to DELETE (the selected text between coordinates)
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

    // This happens when beforeStart is just indentation but the update includes the full line
    let effectiveBeforeStart = beforeStart;
    let effectiveUpdateLines = [...updateLines];
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
          updateFirstLineRaw: `"${updateLines[0]}"`,
          problem: 'Update includes full line with indentation, but beforeStart adds more',
          FIXING: 'Clearing beforeStart AND removing leading whitespace from first update line',
        });
        effectiveBeforeStart = '';
        // Also remove leading whitespace from the first update line since it's already included
        effectiveUpdateLines = [firstUpdateLineTrimmed, ...updateLines.slice(1)];
      }
    }

    let mergedUpdateLines: string[] = [];

    if (isFullLineSelection) {
      mergedUpdateLines = effectiveUpdateLines;
    } else if (effectiveUpdateLines.length === 1) {
      mergedUpdateLines = [effectiveBeforeStart + effectiveUpdateLines[0] + finalAfterEnd];
    } else {
      const firstLine = effectiveBeforeStart + effectiveUpdateLines[0];

      // 🚨 CHECK FOR END DUPLICATION: Similar to start duplication check
      let effectiveAfterEnd = finalAfterEnd;
      const lastUpdateLine = effectiveUpdateLines[effectiveUpdateLines.length - 1];

      // If afterEnd is just whitespace/punctuation and the last update line already includes it
      if (finalAfterEnd.trim().length > 0 && finalAfterEnd.trim().length < 20) {
        const afterEndTrimmed = finalAfterEnd.trim();
        const lastUpdateLineTrimmed = lastUpdateLine.trim();

        // Check if the last update line already ends with what's in afterEnd
        if (lastUpdateLineTrimmed.endsWith(afterEndTrimmed)) {
          console.error('🚨 END DUPLICATION DETECTED!', {
            afterEnd: `"${finalAfterEnd}"`,
            lastUpdateLine: `"${lastUpdateLine}"`,
            problem: 'Last update line already includes afterEnd content',
            FIXING: 'Clearing afterEnd to prevent duplication',
            willRemove: afterEndTrimmed,
          });
          effectiveAfterEnd = finalAfterEnd.substring(
            0,
            finalAfterEnd.length - afterEndTrimmed.length,
          );
        }
      }

      const lastLine = lastUpdateLine + effectiveAfterEnd;

      mergedUpdateLines = [firstLine, ...effectiveUpdateLines.slice(1, -1), lastLine];
    }

    // The join('\n') operation should add newlines between ALL array elements
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
  // CRITICAL: Capture the call stack to identify WHERE this is being called from
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
      // CRITICAL: Only process artifacts that are marked as updates
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

  for (const updateArtifact of updateArtifacts) {
    // snippetContent contains the ORIGINAL snippet from LLM
    // content may contain merged content if displayArtifact was saved
    const updateContent = (updateArtifact as any).snippetContent || updateArtifact.content;
    const newContent = applyPartialUpdate(
      mergedContent, // Build on previous updates sequentially
      updateContent, // CRITICAL: Use SNIPPET, not merged content!
      updateArtifact.id,
      count,
      artifacts, // Pass all artifacts for fallback selection lookup
      false, // CRITICAL FIX: DO NOT skip validation! Let the validation logic find the correct location of originalText
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
function _logContentChanges(
  originalContent: string,
  mergedContent: string,
  _artifactTitle: string,
) {
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
