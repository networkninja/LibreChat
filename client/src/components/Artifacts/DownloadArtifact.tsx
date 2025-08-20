import React, { useState } from 'react';
import { Download } from 'lucide-react';
import type { Artifact } from '~/common';
import { CheckMark } from '@librechat/client';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useEditorContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { convertToHTML } from './ArtifactHtmlConvertor';

const DownloadArtifact = ({
  artifact,
  className = '',
}: {
  artifact: Artifact;
  className?: string;
}) => {
  const localize = useLocalize();
  const { currentCode } = useEditorContext();
  const [isDownloaded, setIsDownloaded] = useState(false);
  const { fileKey: fileName } = useArtifactProps({ artifact });

  const handleDownload = async () => {
    try {
      const content = currentCode ?? artifact.content ?? '';
      if (!content) {
        return;
      }

      // Convert to HTML if it's a React component
      let outputContent = content;
      let mimeType = 'text/plain';
      let downloadFileName = fileName;

      const artifactMimeType = artifact.type;
      console.log('artifactMimeType', artifactMimeType);
      if (
        (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) &&
        artifactMimeType === 'application/vnd.react'
      ) {
        try {
          // Call the updated makeValidHtml function
          const result = await convertToHTML(content, fileName);

          if (result.success) {
            outputContent = result.html;
            mimeType = 'text/html';
            // Use the formatted filename from the result, or fallback to original
            downloadFileName = (result.fileName || fileName).replace(/\.[jt]sx?$/, '') + '.html';
          } else {
            console.warn('HTML conversion failed, downloading original content');
            // Fallback to original content if conversion fails
          }
        } catch (htmlError) {
          console.error('HTML conversion error:', htmlError);
          // Fallback to original content if conversion fails
        }
      }

      const blob = new Blob([outputContent], { type: mimeType });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadFileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      setIsDownloaded(true);
      setTimeout(() => setIsDownloaded(false), 3000);
    } catch (error) {
      console.error('Download failed:', error);
    }
  };

  return (
    <button
      className={`mr-2 text-text-secondary ${className}`}
      onClick={handleDownload}
      aria-label={localize('com_ui_download_artifact')}
    >
      {isDownloaded ? <CheckMark className="h-4 w-4" /> : <Download className="h-4 w-4" />}
    </button>
  );
};

export default DownloadArtifact;
