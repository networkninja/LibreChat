import { artifactCache } from '~/components/Artifacts/artifactCache';
// --- Sanitizer: removes duplicate closing tags, orphan style fragments, dangling tails, duplicated <p> blocks, and DUPLICATE DOCTYPE/HTML ---
// function sanitizeArtifactContent(html: string): string {
//   if (!html) return html;
//   let out = html;

//   // CRITICAL: Remove ALL duplicate DOCTYPE declarations (keep only the first one)
//   const doctypeMatches = out.match(/<!DOCTYPE[^>]*>/gi);
//   if (doctypeMatches && doctypeMatches.length > 1) {
//     console.log('🧹 [sanitize] Found duplicate DOCTYPE declarations:', doctypeMatches.length);
//     // Keep only the first DOCTYPE, remove all others
//     const firstDoctype = doctypeMatches[0];
//     out = out.replace(/<!DOCTYPE[^>]*>/gi, ''); // Remove all
//     out = firstDoctype + out; // Add first one back at the start
//   }

//   // CRITICAL: Remove duplicate <html> opening tags (keep only the first one)
//   const htmlOpenMatches = out.match(/<html[^>]*>/gi);
//   if (htmlOpenMatches && htmlOpenMatches.length > 1) {
//     console.log('🧹 [sanitize] Found duplicate <html> opening tags:', htmlOpenMatches.length);
//     let foundFirst = false;
//     out = out.replace(/<html[^>]*>/gi, (match) => {
//       if (!foundFirst) {
//         foundFirst = true;
//         return match; // Keep first
//       }
//       return ''; // Remove duplicates
//     });
//   }

//   // Deduplicate closing tags
//   out = out.replace(/<\/body>\s*<\/body>/gi, '</body>').replace(/<\/html>\s*<\/html>/gi, '</html>');

//   // CRITICAL: If there are multiple </html> tags, keep only the LAST one
//   const htmlCloseMatches = out.match(/<\/html>/gi);
//   if (htmlCloseMatches && htmlCloseMatches.length > 1) {
//     console.log('🧹 [sanitize] Found duplicate </html> closing tags:', htmlCloseMatches.length);
//     // Remove all but the last one
//     let count = 0;
//     const totalMatches = htmlCloseMatches.length;
//     out = out.replace(/<\/html>/gi, () => {
//       count++;
//       if (count < totalMatches) {
//         return ''; // Remove all except last
//       }
//       return '</html>'; // Keep last one
//     });
//   }

//   // Remove orphan attribute/style fragment lines (e.g., "yle=\"...")
//   out = out
//     .split('\n')
//     .filter((l) => !/^\s*:?(y?le)="[^"]*$/.test(l.trim()))
//     .filter((l) => !/^(y?le)="[^"]*/.test(l.trim()))
//     .join('\n');

//   // Cut off anything after final </html>
//   const htmlCloseIdx = out.toLowerCase().lastIndexOf('</html>');
//   if (htmlCloseIdx !== -1) {
//     out = out.slice(0, htmlCloseIdx + 7);
//   }

//   // Deduplicate identical <p> lines inside body
//   out = out.replace(/(<body[^>]*>)([\s\S]*?)(<\/body>)/i, (_, open, inner, close) => {
//     const seen = new Set<string>();
//     const cleaned = inner
//       .split('\n')
//       .filter((line) => {
//         const trimmed = line.trim();
//         if (!trimmed.startsWith('<p')) return true;
//         if (seen.has(trimmed)) return false;
//         seen.add(trimmed);
//         return true;
//       })
//       .join('\n');
//     return open + cleaned + close;
//   });

//   return out;
// }

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
  skipValidation?: boolean,
): string {
  // --- NEW HELPERS (dedupe & body replacement) ---
  const isFullDoc = (c: string) => /<!DOCTYPE|<html|<head>|<body>/i.test(c);
  const isSnippet = (c: string) => !isFullDoc(c) && /<p[ >]/i.test(c);
  const normalizeSnippet = (c: string) => c.trim().replace(/\n{2,}/g, '\n');
  const extractBody = (c: string) => {
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
  
  // CRITICAL: Extract base identifier EARLY so it's available for snippet logic
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
    console.log('🩹 [Snippet Update] Detected snippet update to full document');

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
      // CRITICAL: NO SELECTION CONTEXT - This happens when:
      // 1. User makes an update immediately after page refresh (cache not loaded yet)
      // 2. Selection context was never saved (bug in ArtifactCodeEditor)
      // 3. Database query failed to load selection context
      console.error(
        '❌ [STRICT MODE] Snippet update WITHOUT selection context - REFUSING to merge',
        {
          artifactId,
          updateContent: updateContent.substring(0, 100),
          action: 'Returning ORIGINAL content - NO APPEND',
          reason: 'Cannot safely append snippet without knowing exact location',
          possibleCauses: [
            '1. Update created before cache loaded from database (timing issue)',
            '2. Selection context was never saved in ArtifactCodeEditor',
            '3. Database query failed or returned no results',
          ],
          solution: [
            'Check that loadConversationCache() was called',
            'Check database has selection_context entries for this conversation',
            'Try refreshing page and waiting a moment before making updates',
          ],
        },
      );

      // Return original content unchanged - the snippet is stored separately in update artifact
      // When selection context becomes available (e.g., after cache loads), merge will work
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

  // CRITICAL FIX: Check if selection cache is empty - this means we're on a fresh page load
  // and the cache hasn't been hydrated from the database yet
  if (artifactCache._selectionCache.size === 0) {
    console.warn(
      '⚠️ [applyPartialUpdate] Selection cache is EMPTY! This should not happen after cache load.',
    );
    console.warn('⚠️ [applyPartialUpdate] Possible causes:');
    console.warn('   1. Database query returned 0 results (wrong conversationId?)');
    console.warn('   2. loadConversationCache was called but found no entries');
    console.warn('   3. Cache was cleared after loading');
    console.warn(
      '⚠️ [applyPartialUpdate] Attempting to load from database for this specific artifact...',
    );

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

  console.log('🔍 [applyPartialUpdate] Cache state:', {
    artifactId,
    totalCacheEntries: allSelectionEntries.length,
    allCacheKeys: allSelectionEntries.map(([key]) => key),
    allCacheDetails: allSelectionEntries.map(([key, val]) => ({
      key,
      artifactId: val.artifactId,
      startLine: val.startLine,
      endLine: val.endLine,
      originalTextPreview: val.originalText?.substring(0, 50),
    })),
  });

  // Strategy 1: Try cached selection context for this artifact first
  let cachedSelection = artifactCache.getSelection(artifactId);
  console.log('artifactCache for selection', cachedSelection);
  const cachedSelectiontest = artifactCache._loadFromDatabase(artifactId);
  console.log(
    '🔍 [applyPartialUpdate] Strategy 1: Trying cached selection for artifact:',
    artifactId,
  );
  // console.log('📍 [applyPartialUpdate] Strategy 1 result (exact ID match):', {
  //   artifactId,
  //   found: !!cachedSelection,
  //   selection: cachedSelection,
  //   selectionTest: cachedSelectiontest,
  //   CRITICAL_CHECK: {
  //     lookingFor: artifactId,
  //     availableKeys: Array.from(artifactCache._selectionCache.keys()),
  //     exactMatch: artifactCache._selectionCache.has(artifactId),
  //   },
  // });

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
    const _searchIdentifier = baseIdentifier || artifactId.split('_update')[0];

    // CRITICAL: Extract the update index from the artifactId to match the CORRECT selection
    // Each update (update0, update1, update2...) should have its OWN selection context
    const updateIndexMatch = artifactId.match(/_update(\d+)_/);
    const updateIndex = updateIndexMatch ? parseInt(updateIndexMatch[1], 10) : null;

    // CRITICAL FIX: Match selection EXACTLY by artifact ID - no fuzzy matching!
    // Fuzzy matching can cause update0's selection to be used for update1
    const exactMatch = allSelectionEntries.find(([key, _val]) => {
      return key.toLowerCase() === artifactId.toLowerCase();
    });

    if (exactMatch) {
      cachedSelection = exactMatch[1];
      console.log('✅✅✅ [applyPartialUpdate] EXACT MATCH FOUND for artifact ID:', {
        requestedArtifactId: artifactId,
        matchedKey: exactMatch[0],
        startLine: cachedSelection.startLine,
        endLine: cachedSelection.endLine,
        startColumn: cachedSelection.startColumn,
        endColumn: cachedSelection.endColumn,
        originalTextPreview: cachedSelection.originalText?.substring(0, 100),
        updatedTextPreview: cachedSelection.updatedText?.substring(0, 100),
        timestamp: cachedSelection.timestamp,
      });
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
  // CRITICAL: Only use this for REFRESH scenarios, NOT for chained updates during streaming
  // For chained updates, each update MUST have its own selection context
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

  console.log('🔍 [applyPartialUpdate] Final content:', updateContent, originalContent);

  // If no valid selection context, treat as FULL REPLACEMENT for update artifacts
  // This is safe for chained updates where we don't have line/column info
  if (
    !cachedSelection ||
    typeof cachedSelection.startLine !== 'number' ||
    typeof cachedSelection.endLine !== 'number' ||
    typeof cachedSelection.startColumn !== 'number' ||
    typeof cachedSelection.endColumn !== 'number'
  ) {
    console.warn('⚠️ NO VALID SELECTION - Will attempt merge anyway', {
      artifactId,
      isUpdateArtifact,
      hasCachedSelection: !!cachedSelection,
      selectionDetails: cachedSelection
        ? {
            startLine: cachedSelection.startLine,
            startLineType: typeof cachedSelection.startLine,
            endLine: cachedSelection.endLine,
            endLineType: typeof cachedSelection.endLine,
            startColumn: cachedSelection.startColumn,
            startColumnType: typeof cachedSelection.startColumn,
            endColumn: cachedSelection.endColumn,
            endColumnType: typeof cachedSelection.endColumn,
            artifactId: cachedSelection.artifactId,
            fileKey: cachedSelection.fileKey,
            originalText: cachedSelection.originalText?.substring(0, 100),
          }
        : 'NO SELECTION OBJECT',
      allCachedKeys: Array.from(artifactCache._selectionCache.keys()),
    });

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

  // CRITICAL: VALIDATE that originalText matches what's currently at the specified location
  // This prevents updates from being applied to the wrong location
  // SKIP validation when applying sequential chained updates (validation would fail after first update)
  if (!skipValidation && cachedSelection?.originalText) {
    console.log('🔍 [VALIDATION] Checking if originalText matches current content...');

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

    // NEW: If text doesn't match, search for it in nearby lines (±5 lines)
    if (currentTextAtLocation !== cachedSelection.originalText) {
      console.warn('⚠️ [VALIDATION] Text mismatch - searching nearby lines...', {
        originalStartLine: startLine,
        originalEndLine: endLine,
        searchingRange: `${Math.max(0, startLine - 5)} to ${Math.min(lines.length - 1, endLine + 5)}`,
      });

      let foundMatch = false;
      let newStartLine = startLine;
      let newEndLine = endLine;
      let newStartColumn = startColumn;
      let newEndColumn = endColumn;

      // Search in a window of ±5 lines
      const searchWindowStart = Math.max(0, startLine - 5);
      const searchWindowEnd = Math.min(lines.length - 1, endLine + 5);

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
            const firstLineText = lines[searchLine];
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
            
            foundMatch = true;
            console.log('✅ [VALIDATION] Found multi-line originalText at different location!', {
              originalStartLine: startLine,
              foundAtLine: newStartLine,
              lineOffset: newStartLine - startLine,
            });
            break;
          }
        }
      }

      if (foundMatch) {
        // Update the coordinates to use the corrected location
        console.log('🔧 [VALIDATION] Correcting line/column numbers:', {
          before: { startLine, endLine, startColumn, endColumn },
          after: { startLine: newStartLine, endLine: newEndLine, startColumn: newStartColumn, endColumn: newEndColumn },
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
          currentTextAtLocation = correctedLines[newStartLine]?.slice(newStartColumn, newEndColumn) || '';
        } else {
          const firstLinePart = correctedLines[newStartLine]?.slice(newStartColumn) || '';
          const lastLinePart = correctedLines[newEndLine]?.slice(0, newEndColumn) || '';
          const middleLines = correctedLines.slice(newStartLine + 1, newEndLine);
          currentTextAtLocation = [firstLinePart, ...middleLines, lastLinePart].join('\n');
        }

        console.log('✅ [VALIDATION] Verified corrected location matches:', {
          matches: currentTextAtLocation === cachedSelection.originalText,
        });
      } else {
        console.error('❌ [VALIDATION] Could not find originalText in nearby lines!', {
          searchedLines: `${searchWindowStart} to ${searchWindowEnd}`,
          originalText: cachedSelection.originalText.substring(0, 100),
          decision: 'Proceeding with original coordinates (may fail)',
        });
      }
    } else {
      console.log('✅ [VALIDATION PASSED] Original text matches - safe to apply update');
    }
  } else if (skipValidation) {
    console.log('⏭️ [VALIDATION SKIPPED] Sequential update mode - validation disabled');
  } else {
    console.warn('⚠️ [VALIDATION SKIPPED] No originalText in selection context');
  }

  // Re-extract line/column numbers (may have been corrected above)
  const finalStartLine = cachedSelection.startLine;
  const finalEndLine = cachedSelection.endLine;
  const finalStartColumn = cachedSelection.startColumn;
  const finalEndColumn = cachedSelection.endColumn;
  
  console.log('📝 [MERGE CONTENT] What we are replacing:', {
    originalContentPreview: originalContent.substring(0, 300),
    updateContentPreview: updateContent.substring(0, 300),
    lineBeingModified: finalStartLine,
    currentLineContent: lines[finalStartLine],
    selectedTextInLine: lines[finalStartLine]?.substring(finalStartColumn, finalEndColumn),
  });

  console.log('updateContent', updateContent, finalStartLine, finalEndLine, finalStartColumn, finalEndColumn);
  console.log('updateLines', updateLines);
  if (finalStartLine === finalEndLine) {
    // Single-line selection: replace only the substring
    const line = lines[finalStartLine] || '';
    const before = line.slice(0, finalStartColumn);
    const after = line.slice(finalEndColumn);

    console.log('🎯 [SINGLE LINE UPDATE]:', {
      lineNumber: finalStartLine,
      originalLine: line,
      selectedPortion: line.slice(finalStartColumn, finalEndColumn),
      before: before,
      after: after,
      updateContent: updateContent,
      willBecome: before + updateContent + after,
    });


    // CRITICAL: If updateContent has newlines but we're replacing a single line,
    // we need to handle it as a multi-line replacement
    // NOTE: updateLines is already declared at line 649, don't redeclare it here
    console.log('updateLinesLength', updateLines.length);
    if (updateContent.includes('\n') && updateLines.length > 1) {
      const firstLine = before + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + after;
      const middleLines = updateLines.slice(1, -1);

      console.log('Multi-line update in single-line selection:', {
        before: `"${before}"`,
        after: `"${after}"`,
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
      console.log('Result lines:', newLines);
      const result = newLines.join('\n');
      return result.replace(/\n$/, ''); // Strip only the last newline
    }

    lines[finalStartLine] = before + updateContent + after;
    console.log('lines after single line update artifactutls', lines[finalStartLine], updateContent);
    return lines.join('\n');
  } else {
    // Multi-line selection: replace partial start/end lines and all lines in between
    const beforeStart = lines[finalStartLine]?.slice(0, finalStartColumn) || '';
    const afterEnd = lines[finalEndLine]?.slice(finalEndColumn) || '';
    const before = lines.slice(0, finalStartLine);
    const after = lines.slice(finalEndLine + 1);

    // console.log('🔧 [MULTI-LINE UPDATE]:', {
    //   startLine,
    //   startColumn,
    //   endColumn,
    //   beforeStart: `"${beforeStart}"`,
    //   afterEnd: `"${afterEnd}"`,
    //   updateLinesCount: updateLines.length,
    //   updateContentPreview: updateContent.substring(0, 200),
    //   originalLineAtStart: lines[startLine],
    //   originalLineAtEnd: lines[endLine],
    //   linesBeforeSelection: before.length,
    //   linesAfterSelection: after.length,
    // });

    console.log('📋 [MULTI-LINE UPDATE] Original lines being replaced:', {
      lineRange: `${startLine}-${endLine}`,
      linesToReplace: lines.slice(startLine, endLine + 1),
    });

    // CRITICAL: Check if start/end are at line boundaries (full line selection)
    // If startColumn is 0 and endColumn is at end of line, don't add prefix/suffix
    const isFullLineSelection =
      finalStartColumn === 0 && (afterEnd.trim() === '' || finalEndColumn === (lines[finalEndLine]?.length || 0));

    console.log('🔍 [applyPartialUpdate] Selection type:', {
      isFullLineSelection,
      startColumnIsZero: startColumn === 0,
      afterEndIsEmpty: afterEnd.trim() === '',
      endColumnAtLineEnd: endColumn === (lines[endLine]?.length || 0),
    });

    let mergedUpdateLines: string[] = [];

    if (isFullLineSelection) {
      // Full line selection - just use the update content as-is
      console.log('✅ Full line selection detected - using update content directly');
      mergedUpdateLines = updateLines;
    } else if (updateLines.length === 1) {
      // Single update line replaces the whole region - add prefix and suffix
      console.log('✅ Single-line replacement in multi-line selection');
      mergedUpdateLines = [beforeStart + updateLines[0] + afterEnd];
    } else {
      const firstLine = beforeStart + updateLines[0];
      const lastLine = updateLines[updateLines.length - 1] + afterEnd;

      mergedUpdateLines = [firstLine, ...updateLines.slice(1, -1), lastLine];

      console.log('✅ Multi-line merge complete:', {
        updateLinesCount: updateLines.length,
        beforeStart: `"${beforeStart}"`,
        afterEnd: `"${afterEnd}"`,
        firstLine: `"${firstLine}"`,
        middleLinesCount: updateLines.slice(1, -1).length,
        lastLine: `"${lastLine}"`,
        totalMergedLines: mergedUpdateLines.length,
        mergedUpdateLinesPreview: mergedUpdateLines.slice(0, 3),
      });
    }

    const mergedContent = [...before, ...mergedUpdateLines, ...after].join('\n');

    console.log('🎯 [FINAL MERGE RESULT]:', {
      beforeLinesCount: before.length,
      mergedUpdateLinesCount: mergedUpdateLines.length,
      afterLinesCount: after.length,
      originalLineCount: lines.length,
      mergedLineCount: mergedContent.split('\n').length,
      mergedPreview: mergedContent.substring(0, 500),
    });
    
    console.log('📍 [FINAL MERGE BREAKDOWN]:', {
      beforeLines: before.slice(0, 3),
      mergedUpdateLines: mergedUpdateLines,
      afterLines: after.slice(0, 3),
      finalResultPreview: mergedContent.split('\n').slice(0, 10),
    });

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
      // Return a safe fallback - empty or minimal content
      // This prevents the duplication from propagating
      return ''; // Or return some minimal safe content
    }
  }

  // Start with the original base content, then apply each update sequentially

  // DISABLED: Cache-first strategy was causing stale content on refresh
  // The merge is always recomputed to ensure correctness
  // Cache is only used to SAVE results, not to SHORT-CIRCUIT the merge logic

  // CRITICAL: The identifier is the SAME for base and update artifacts
  // Don't try to split it - just use it directly
  const targetBaseIdentifier = targetArtifact?.identifier;
  console.log('artifacts', artifacts);

  // CRITICAL: Extract the target index from the target artifact if it's an update
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
  // console.log('updateArtifacts', updateArtifacts);

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
      updateArtifact.content, // Apply this update's content
      updateArtifact.id,
      count,
      artifacts, // Pass all artifacts for fallback selection lookup
      true, // CRITICAL: Skip validation in sequential mode - coordinates are relative to base, not current merged content
    );

    if (newContent !== mergedContent) {
      console.log('✅ Content changed, updating mergedContent');
      mergedContent = newContent;

      // NOTE: We do NOT clear the selection here anymore!
      // Each update artifact needs to preserve its selection context for debugging
      // and for potential re-application scenarios
      console.log('✅ Keeping selection cache for:', updateArtifact.id);

      // CRITICAL: Do NOT cache intermediate updates here!
      // Only the FINAL/TARGET update should be cached (done after loop completes)
      // Otherwise all update artifacts end up with the same final merged content
      console.log('⏸️ Skipping intermediate cache save - only final update will be cached:', {
        currentUpdateId: updateArtifact.id,
        targetArtifactId,
        isTargetUpdate: updateArtifact.id === targetArtifactId,
        willCacheAfterLoop: updateArtifact.id === targetArtifactId,
      });
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
  return mergedContent;
}
