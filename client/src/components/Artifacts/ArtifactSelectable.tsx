/* eslint-disable i18next/no-literal-string */
import React, { useState, useRef, useCallback } from 'react';
import { SelectionRange, SelectableArtifactProps } from '~/common';

const SelectableArtifact: React.FC<SelectableArtifactProps> = ({
  content,
  language,
  onSelectionChange,
  allowMultipleSelections = false,
}) => {
  const [selections, setSelections] = useState<SelectionRange[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (selectedText.length === 0) return;

    const selectionRange: SelectionRange = {
      start: range.startOffset,
      end: range.endOffset,
      selectedText,
    };

    if (allowMultipleSelections) {
      setSelections((prev) => [...prev, selectionRange]);
    } else {
      setSelections([selectionRange]);
    }

    onSelectionChange?.(selectionRange);
    selection.removeAllRanges();
  }, [onSelectionChange, allowMultipleSelections]);

  const clearSelections = useCallback(() => {
    setSelections([]);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  return (
    <div className="selectable-artifact">
      <div className="artifact-toolbar">
        <button
          onClick={clearSelections}
          className="btn-clear-selection"
          disabled={selections.length === 0}
        >
          Clear Selection ({selections.length})
        </button>
      </div>

      <div
        ref={contentRef}
        className="artifact-content selectable"
        onMouseUp={handleMouseUp}
        style={{ userSelect: 'text' }}
      >
        <pre className={`language-${language || 'text'}`}>
          <code>{content}</code>
        </pre>
      </div>

      {selections.length > 0 && (
        <div className="selections-summary">
          <h4>Selected Parts:</h4>
          {selections.map((sel, idx) => (
            <div key={idx} className="selection-item">
              <code>{sel.selectedText}</code>
              <button
                onClick={() => setSelections((prev) => prev.filter((_, i) => i !== idx))}
                className="btn-remove-selection"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SelectableArtifact;
