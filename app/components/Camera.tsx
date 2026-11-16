'use client';

import { useEffect, useRef, useState } from 'react';
import type { Position } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
import type { CapturedPhoto } from '@/lib/proof';

const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.7;

/**
 * Live in-app camera. Photos can only be taken here (no gallery uploads),
 * and each one is stamped with the GPS position and time at capture.
 */
export function Camera({
  position,
  photos,
  onChange,
  max = 4,
}: {
  position: Position | null;
  photos: CapturedPhoto[];
  onChange: (photos: CapturedPhoto[]) => void;
  max?: number;
}) {
  const { t } = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((e: Error) => setError(e.message));
    return () => stream?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    const urls = photos.map((p) => URL.createObjectURL(p.blob));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [photos]);

  async function capture() {
    const video = videoRef.current;
    if (!video || !position || video.videoWidth === 0) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return;
    onChange([
      ...photos,
      { blob, lat: position.lat, lng: position.lng, accuracyM: position.accuracyM, takenAtMs: Date.now() },
    ]);
  }

  return (
    <div className="camera">
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <video ref={videoRef} autoPlay playsInline muted className="viewfinder" />
      )}
      <button className="primary" onClick={capture} disabled={!position || photos.length >= max || !!error}>
        {position ? `${t('capture')} (${photos.length}/${max})` : t('locating')}
      </button>
      <div className="thumbs">
        {previews.map((url, i) => (
          <figure key={url}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" />
            <button className="link small" onClick={() => onChange(photos.filter((_, j) => j !== i))}>
              {t('retake')}
            </button>
          </figure>
        ))}
      </div>
    </div>
  );
}
