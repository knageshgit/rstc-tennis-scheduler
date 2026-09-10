/**
 * Preparing a camera shot for upload, in the browser.
 *
 * A phone hands over 3-5MB of JPEG at 4000px wide. Sending that as-is would be
 * slow on club wifi, would blow the store's per-record ceiling, and would fill
 * the database in a couple of mornings. So the resizing happens here, on the
 * device that already has the pixels, before anything is sent.
 *
 * Two things this must get right that are easy to miss:
 *
 * Orientation. A photo taken with the phone rotated is stored the right way up
 * only in its EXIF header, and drawing it to a canvas throws that away, so
 * everyone's action shots end up on their side. `createImageBitmap` is asked
 * for `imageOrientation: "from-image"`, which applies the rotation to the
 * pixels themselves.
 *
 * Weight. Quality is stepped down until the encoded result fits the limit
 * rather than guessed at once, because how well a photo compresses depends
 * entirely on the photo: a plain blue sky and a crowd of players at the same
 * quality differ several-fold.
 *
 * Browser-only. Nothing here is imported by the server or by a test.
 */
import {
  FULL_EDGE,
  MAX_FULL_BYTES,
  MAX_THUMB_BYTES,
  THUMB_EDGE,
  fitWithin,
  type PhotoType,
} from "./photos";

export interface PreparedPhoto {
  /** Base64 of the full-size copy, no data: prefix. */
  full: string;
  /** Base64 of the grid thumbnail. */
  thumb: string;
  type: PhotoType;
  width: number;
  height: number;
  fullBytes: number;
  thumbBytes: number;
}

/** Quality ladder, tried in order until the encoded image fits. */
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.52, 0.42];

/**
 * Read a file from the camera or the photo roll into an upload-ready pair.
 *
 * Throws with a sentence worth showing a member; the caller puts it on screen
 * unchanged.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file is not a photo.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Safari on older iOS cannot decode HEIC through createImageBitmap even
    // though the camera produces it. Nothing can be done in the page, so say
    // what would fix it rather than failing silently.
    throw new Error(
      "This phone gave us a photo format the browser cannot read. In Settings, " +
        "Camera, Formats, choose Most Compatible, then try again."
    );
  }

  try {
    const full = await encodeToFit(bitmap, FULL_EDGE, MAX_FULL_BYTES);
    const thumb = await encodeToFit(bitmap, THUMB_EDGE, MAX_THUMB_BYTES);
    return {
      full: full.base64,
      thumb: thumb.base64,
      type: "image/jpeg",
      width: full.width,
      height: full.height,
      fullBytes: full.bytes,
      thumbBytes: thumb.bytes,
    };
  } finally {
    // Free the decoded pixels rather than waiting for the collector; on a phone
    // with several photos queued this is the difference between working and
    // the tab being killed.
    bitmap.close();
  }
}

async function encodeToFit(
  bitmap: ImageBitmap,
  edge: number,
  maxBytes: number
): Promise<{ base64: string; bytes: number; width: number; height: number }> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not process the photo.");
  // Downscaling in one step from 4000px is what produces the harsh, aliased
  // look; asking for high-quality smoothing costs nothing here.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);

  let last: Blob | null = null;
  for (const quality of QUALITY_STEPS) {
    const blob = await toBlob(canvas, quality);
    last = blob;
    if (blob.size <= maxBytes) {
      return { base64: await toBase64(blob), bytes: blob.size, width, height };
    }
  }

  // Every quality step was still too heavy, which in practice means a very
  // large, very detailed image. Halve the edge once and take what we get.
  if (edge > 400) return encodeToFit(bitmap, Math.round(edge / 2), maxBytes);
  if (!last) throw new Error("That photo could not be prepared for upload.");
  return { base64: await toBase64(last), bytes: last.size, width, height };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("That photo could not be prepared."))),
      "image/jpeg",
      quality
    );
  });
}

/**
 * Blob to base64, without the `data:image/jpeg;base64,` prefix.
 *
 * FileReader rather than a loop over the bytes: a 700KB image is 700,000
 * iterations of `String.fromCharCode` otherwise, which visibly janks the page
 * on a mid-range phone.
 */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That photo could not be read."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}
