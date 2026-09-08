// 手机端图片上传的压缩与打包（PHONE_ACTIONS_PLAN.md §8.8）。
//
// 为什么不复用 services/fileParser.ts 的 compressImage：那个模块顶层就
// `import * as pdfjsLib from 'pdfjs-dist'` + `import mammoth from 'mammoth'`，
// 一 import 就把 PDF/DOCX 解析器整个拖进 viewer 的 chunk。手机端只发图，
// 用不到那两个几百 KB 的解析器，所以这里写一份精简版。
//
// 与 fileParser 的另外两处差别：
// - 输出优先 webp（同画质下比 jpeg 小三成左右），浏览器不支持才退回 jpeg；
// - 先按长边限一次尺寸（≤ 1600px）再降质量，手机随手一拍就是 4000px，
//   只降质量的话要迭代很多轮才压得下来，还糊。

import { ACTION_LIMITS, type ActionAttachmentMimeType } from '../server/actionContract';

/** 压缩后长边不超过这个像素数。视觉模型普遍在 1024–1568 之间下采样，再大是白花流量。 */
export const MAX_UPLOAD_EDGE = 1600;

/** 压缩目标：单张 ≤ 1 MB（解码后字节）。够不到就一路降质量 / 降尺寸。 */
export const UPLOAD_TARGET_BYTES = 1024 * 1024;

/** 服务端的硬上限，超了必被 400，所以本地先拦掉并给提示。 */
export const UPLOAD_MAX_BYTES = ACTION_LIMITS.attachmentBytes;

/** 输入框上方待发的一张图。`data` 是发给服务端的纯 base64，`dataUrl` 给缩略图和乐观占位用。 */
export interface DraftAttachment {
  id: string;
  mimeType: ActionAttachmentMimeType;
  /** 纯 base64，不带 `data:` 前缀（契约要求） */
  data: string;
  /** `data:<mime>;base64,<data>`，本地预览用 */
  dataUrl: string;
  fileName?: string;
  /** 解码后字节数 */
  bytes: number;
}

/** 失败原因短码，交给 ViewerApp 翻成文案。 */
export type ImagePrepErrorCode = 'not-an-image' | 'too-large' | 'decode-failed';

export class ImagePrepError extends Error {
  code: ImagePrepErrorCode;
  constructor(code: ImagePrepErrorCode) {
    super(code);
    this.code = code;
  }
}

let webpSupport: boolean | null = null;

/** 浏览器 canvas 能不能吐 webp。Safari 16.4 起可以，更早的退回 jpeg。 */
function canEncodeWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    webpSupport = c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/** data URL 拆成 mime + 纯 base64。 */
function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const m = /^data:([^;,]+)/.exec(head);
  return { mimeType: m ? m[1] : 'application/octet-stream', data };
}

/** 纯 base64 的解码后字节数（不真的解码）。 */
export function base64Bytes(data: string): number {
  let pad = 0;
  if (data.endsWith('==')) pad = 2;
  else if (data.endsWith('=')) pad = 1;
  return Math.max(0, (data.length / 4) * 3 - pad);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new ImagePrepError('decode-failed'));
    fr.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImagePrepError('decode-failed'));
    img.src = url;
  });
}

/**
 * 把一个用户选中的图片文件压成可以发出去的附件。
 *
 * - GIF **原样发**：canvas 重编码只会留下第一帧，动图就没了。代价是不压缩，
 *   所以超过服务端上限（4 MB）时直接拒绝，让用户自己换一张。
 * - 其余格式（含 iOS 的 HEIC——Safari 的 canvas 解得开）一律重编码成 webp / jpeg。
 */
export async function compressImageForUpload(file: File): Promise<DraftAttachment> {
  const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = file.name || undefined;

  if (!file.type || file.type.indexOf('image/') !== 0) throw new ImagePrepError('not-an-image');

  // --- GIF：不动它 ---
  if (file.type === 'image/gif') {
    if (file.size > UPLOAD_MAX_BYTES) throw new ImagePrepError('too-large');
    const dataUrl = await readAsDataUrl(file);
    const { data } = splitDataUrl(dataUrl);
    const bytes = base64Bytes(data);
    if (bytes > UPLOAD_MAX_BYTES) throw new ImagePrepError('too-large');
    return { id, mimeType: 'image/gif', data, dataUrl, fileName, bytes };
  }

  // --- 其余：解码 → 限长边 → 迭代降质量 / 降尺寸 ---
  const sourceUrl = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(sourceUrl);
  } finally {
    // 图已经解到内存里了，object URL 可以立刻放掉
    URL.revokeObjectURL(sourceUrl);
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new ImagePrepError('decode-failed');

  const outMime: ActionAttachmentMimeType = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImagePrepError('decode-failed');

  // 起手就按长边收进 MAX_UPLOAD_EDGE（放大没意义，所以 scale 不超过 1）
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  let scale = longEdge > MAX_UPLOAD_EDGE ? MAX_UPLOAD_EDGE / longEdge : 1;
  let quality = 0.85;

  const encode = (): string => {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(outMime, quality);
  };

  let dataUrl = encode();
  let parts = splitDataUrl(dataUrl);
  let bytes = base64Bytes(parts.data);

  for (let attempt = 0; attempt < 10 && bytes > UPLOAD_TARGET_BYTES; attempt++) {
    if (quality > 0.45) quality -= 0.1;
    else if (scale > 0.3) {
      scale *= 0.75;
      quality = 0.75; // 尺寸降下来之后质量可以放回去一点
    } else break;
    dataUrl = encode();
    parts = splitDataUrl(dataUrl);
    bytes = base64Bytes(parts.data);
  }

  // toDataURL 在不支持的格式上会静默退回 image/png，那样 mimeType 就和内容对不上了（服务端验魔数会 400）
  const actualMime = parts.mimeType === 'image/webp' || parts.mimeType === 'image/jpeg' || parts.mimeType === 'image/png'
    ? (parts.mimeType as ActionAttachmentMimeType)
    : outMime;

  if (bytes > UPLOAD_MAX_BYTES) throw new ImagePrepError('too-large');

  return { id, mimeType: actualMime, data: parts.data, dataUrl, fileName, bytes };
}
