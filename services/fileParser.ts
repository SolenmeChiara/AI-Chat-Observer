
import { Attachment } from '../types';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// Robustly get the PDFJS library object.
// In some ESM environments, the exports might be wrapped in 'default'.
const pdfjs = (pdfjsLib as any).default || pdfjsLib;

// Configure PDF Worker
if (pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@3.11.174/build/pdf.worker.min.mjs';
}

// Image compression options
export interface CompressionOptions {
  enabled: boolean;
  maxSizeMB: number;
}

// Helper: Calculate base64 size in bytes
const getBase64Size = (base64: string): number => {
  // Remove data URL prefix if present
  const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
  // Base64 is ~4/3 of original size, so multiply by 0.75 to get actual bytes
  return Math.ceil(base64Data.length * 0.75);
};

// Helper: Compress image using canvas
const compressImage = async (
  dataUrl: string,
  maxSizeBytes: number,
  originalMimeType: string
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let quality = 0.9;
      let scale = 1.0;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Cannot get canvas context'));
        return;
      }

      // Determine output format (prefer webp for better compression, fallback to jpeg)
      const outputFormat = 'image/jpeg'; // JPEG has best compatibility

      const tryCompress = (): string => {
        canvas.width = Math.floor(img.width * scale);
        canvas.height = Math.floor(img.height * scale);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL(outputFormat, quality);
      };

      let result = tryCompress();
      let currentSize = getBase64Size(result);

      // Iteratively reduce quality and/or scale until under target size
      let attempts = 0;
      const maxAttempts = 10;

      while (currentSize > maxSizeBytes && attempts < maxAttempts) {
        attempts++;

        if (quality > 0.3) {
          // First try reducing quality
          quality -= 0.1;
        } else if (scale > 0.25) {
          // Then try reducing scale
          scale -= 0.15;
          quality = 0.8; // Reset quality when scaling down
        } else {
          // Can't compress further
          break;
        }

        result = tryCompress();
        currentSize = getBase64Size(result);
      }

      console.log(`Image compressed: ${(currentSize / 1024 / 1024).toFixed(2)}MB, quality=${quality.toFixed(2)}, scale=${scale.toFixed(2)}`);
      resolve(result);
    };

    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = dataUrl;
  });
};

export const parseFile = async (
  file: File,
  compression?: CompressionOptions
): Promise<Attachment> => {
  const fileType = file.type;
  let textContent = '';
  let attachmentType: 'image' | 'document' = 'document';
  let base64Content = '';

  // Helper to read file as Base64 (for images)
  const readAsBase64 = (f: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });
  };

  // Helper to read file as ArrayBuffer (for PDF/Docx)
  const readAsArrayBuffer = (f: File): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(f);
    });
  };

  // Helper to read file as Text (for TXT/MD/JSON)
  const readAsText = (f: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(f);
    });
  };

  // Track actual MIME type (may differ from file.type)
  let actualMimeType = fileType;

  try {
    // 1. IMAGE HANDLING
    if (fileType.startsWith('image/')) {
      attachmentType = 'image';
      base64Content = await readAsBase64(file);

      // Extract actual MIME type from data URL (more reliable than file.type)
      // Format: data:image/png;base64,xxxxx
      const mimeMatch = base64Content.match(/^data:([^;]+);base64,/);
      if (mimeMatch) {
        actualMimeType = mimeMatch[1];
      }

      // Apply compression if enabled and image is too large
      if (compression?.enabled) {
        const maxSizeBytes = compression.maxSizeMB * 1024 * 1024;
        const currentSize = getBase64Size(base64Content);

        if (currentSize > maxSizeBytes) {
          console.log(`Image size ${(currentSize / 1024 / 1024).toFixed(2)}MB exceeds limit ${compression.maxSizeMB}MB, compressing...`);
          base64Content = await compressImage(base64Content, maxSizeBytes, actualMimeType);
          // Update MIME type after compression (now JPEG)
          actualMimeType = 'image/jpeg';
        }
      }
      // No text extraction for basic images (unless we add OCR later)
    } 
    
    // 2. PDF HANDLING
    else if (fileType === 'application/pdf') {
      const arrayBuffer = await readAsArrayBuffer(file);
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      
      let fullText = '';
      // Limit to first 20 pages to avoid crashing browser/context
      const maxPages = Math.min(pdf.numPages, 20);
      
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const textContentObj = await page.getTextContent();
        const pageText = textContentObj.items.map((item: any) => item.str).join(' ');
        fullText += `[Page ${i}]\n${pageText}\n\n`;
      }
      
      if (pdf.numPages > 20) fullText += `\n[...Truncated after 20 pages...]`;
      textContent = fullText.trim();
    }
    
    // 3. WORD (.DOCX) HANDLING
    else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const arrayBuffer = await readAsArrayBuffer(file);
      const result = await mammoth.extractRawText({ arrayBuffer });
      textContent = result.value.trim();
    }
    
    // 4. TEXT / CODE HANDLING
    else if (
        fileType === 'text/plain' || 
        fileType === 'text/markdown' || 
        fileType === 'application/json' ||
        file.name.endsWith('.ts') ||
        file.name.endsWith('.js') ||
        file.name.endsWith('.py') ||
        file.name.endsWith('.tsx') ||
        file.name.endsWith('.jsx') ||
        file.name.endsWith('.html') ||
        file.name.endsWith('.css')
    ) {
        textContent = await readAsText(file);
    } 
    
    // Fallback
    else {
       textContent = `[Cannot extract text from file type: ${fileType}]`;
    }

  } catch (e: any) {
    console.error("File parsing error", e);
    textContent = `[Error parsing file: ${e.message}]`;
  }

  return {
    type: attachmentType,
    content: base64Content, // Only populated for images
    textContent: textContent, // Populated for docs
    mimeType: actualMimeType, // Use actual detected MIME type
    fileName: file.name
  };
};
