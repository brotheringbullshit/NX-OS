import React from 'react';

interface GameArtworkProps {
  artworkId: string;
  title: string;
  artworkImages?: Record<string, string>;
  className?: string;
}

/**
 * Renders box artwork directly from /sys/assets/artwork_pack.bin (ART0)
 * decoded out of SYSTEM NAND chunks during boot.
 */
export const GameArtwork: React.FC<GameArtworkProps> = ({
  artworkId,
  title,
  artworkImages,
  className = 'w-full h-full',
}) => {
  const src = artworkImages?.[artworkId];

  if (src) {
    return (
      <img
        src={src}
        alt={title}
        draggable={false}
        className={`${className} object-cover select-none`}
      />
    );
  }

  return (
    <div
      className={`${className} bg-slate-800 text-slate-200 flex flex-col items-center justify-center p-3 text-center`}
      aria-label={title}
    >
      <div className="font-display font-bold text-xs uppercase tracking-wider">
        {title}
      </div>
      <div className="text-[10px] font-mono-tabular text-slate-400 mt-1">
        Missing ART0:{artworkId}
      </div>
    </div>
  );
};
