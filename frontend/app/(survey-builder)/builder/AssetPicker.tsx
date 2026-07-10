"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ImagePlus,
  Music,
  Film,
  Upload,
  Library,
  X,
  Loader2,
  Trash2,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import {
  Asset,
  AssetKind,
  deleteAsset,
  listAssets,
  uploadAsset,
} from "@/utils/assets";
import { resolveAssetUrl } from "./design";

interface Props {
  kind: AssetKind;
  value?: string; // relative /assets/… url
  onChange: (url: string | undefined) => void;
  label?: string;
}

/**
 * Reusable control to pick, upload, preview and clear a media asset.
 * Always emits the relative URL returned by the API (never absolutized).
 */
const KIND_LABELS: Record<AssetKind, { uploaded: string; accept: string }> = {
  image: { uploaded: "Imagen subida", accept: "image/*" },
  audio: { uploaded: "Audio subido", accept: "audio/*" },
  video: { uploaded: "Video subido", accept: "video/*" },
};

export function AssetPicker({ kind, value, onChange, label }: Props) {
  const isImage = kind === "image";
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      setUploading(true);
      try {
        const asset = await uploadAsset(file);
        onChange(asset.url);
        toast.success(KIND_LABELS[kind].uploaded);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "No se pudo subir el archivo."
        );
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [kind, onChange]
  );

  return (
    <div>
      {label && (
        <span className="block text-xs font-medium text-neutral-600 mb-1.5">
          {label}
        </span>
      )}

      {value ? (
        <Preview
          kind={kind}
          value={value}
          onReplace={() => inputRef.current?.click()}
          onRemove={() => onChange(undefined)}
          uploading={uploading}
        />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-3 py-2.5 text-xs font-medium text-neutral-600 hover:border-neutral-400 hover:bg-neutral-50 transition-colors disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : isImage ? (
              <ImagePlus className="w-4 h-4" />
            ) : kind === "video" ? (
              <Film className="w-4 h-4" />
            ) : (
              <Music className="w-4 h-4" />
            )}
            {uploading ? "Subiendo…" : "Subir"}
          </button>
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            disabled={uploading}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 transition-colors disabled:opacity-60"
            title="Elegir de la biblioteca"
          >
            <Library className="w-4 h-4" /> Biblioteca
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={KIND_LABELS[kind].accept}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {libraryOpen && (
        <LibraryDialog
          kind={kind}
          current={value}
          onClose={() => setLibraryOpen(false)}
          onPick={(url) => {
            onChange(url);
            setLibraryOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Preview({
  kind,
  value,
  onReplace,
  onRemove,
  uploading,
}: {
  kind: AssetKind;
  value: string;
  onReplace: () => void;
  onRemove: () => void;
  uploading: boolean;
}) {
  const src = resolveAssetUrl(value);
  return (
    <div className="rounded-lg border border-neutral-200 p-2">
      {kind === "image" ? (
        <div className="relative w-full h-32 rounded-md overflow-hidden bg-neutral-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="Vista previa"
            className="w-full h-full object-cover"
          />
        </div>
      ) : kind === "video" ? (
        <video
          controls
          src={src}
          className="w-full rounded-md bg-black"
          style={{ maxHeight: 200 }}
        >
          Tu navegador no admite video.
        </video>
      ) : (
        <audio controls src={src} className="w-full">
          Tu navegador no admite audio.
        </audio>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onReplace}
          disabled={uploading}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Upload className="w-3.5 h-3.5" />
          )}
          Reemplazar
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
        >
          <X className="w-3.5 h-3.5" /> Quitar
        </button>
      </div>
    </div>
  );
}

function LibraryDialog({
  kind,
  current,
  onClose,
  onPick,
}: {
  kind: AssetKind;
  current?: string;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    setAssets(null);
    listAssets(kind)
      .then(setAssets)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "No se pudo cargar.");
        setAssets([]);
      });
  }, [kind]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function remove(id: string) {
    try {
      await deleteAsset(id);
      setAssets((prev) => (prev ? prev.filter((a) => a.id !== id) : prev));
      toast.success("Archivo eliminado");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "No se pudo eliminar."
      );
    }
  }

  const isImage = kind === "image";
  const libraryTitle =
    kind === "image"
      ? "Biblioteca de imágenes"
      : kind === "video"
        ? "Biblioteca de video"
        : "Biblioteca de audio";
  const emptyLabel =
    kind === "image" ? "imágenes" : kind === "video" ? "videos" : "audios";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-neutral-800">
            {libraryTitle}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {assets === null && (
            <div className="grid place-items-center py-12 text-sm text-neutral-400">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
              </span>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {assets !== null && !error && assets.length === 0 && (
            <div className="grid place-items-center py-12 text-center text-sm text-neutral-400">
              Todavía no subiste {emptyLabel}. Usá “Subir” para agregar el
              primero.
            </div>
          )}

          {assets && assets.length > 0 && isImage && (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {assets.map((a) => {
                const active = a.url === current;
                return (
                  <div key={a.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onPick(a.url)}
                      className={`relative block w-full aspect-square overflow-hidden rounded-lg border-2 transition-colors ${
                        active
                          ? "border-[#8faf0e]"
                          : "border-transparent hover:border-neutral-300"
                      }`}
                      title={a.original_name ?? ""}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resolveAssetUrl(a.url)}
                        alt={a.original_name ?? ""}
                        className="w-full h-full object-cover bg-neutral-100"
                      />
                      {active && (
                        <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[#8faf0e] text-[#1e2a06]">
                          <Check className="w-3 h-3" />
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(a.id)}
                      className="absolute left-1 top-1 hidden rounded-md bg-white/90 p-1 text-red-600 shadow-sm hover:bg-white group-hover:block"
                      title="Eliminar de la biblioteca"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {assets && assets.length > 0 && !isImage && (
            <ul className="space-y-2">
              {assets.map((a) => {
                const active = a.url === current;
                return (
                  <li
                    key={a.id}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                      active ? "border-[#8faf0e] bg-[#8faf0e0a]" : "border-neutral-200"
                    }`}
                  >
                    {kind === "video" ? (
                      <Film className="w-4 h-4 shrink-0 text-neutral-400" />
                    ) : (
                      <Music className="w-4 h-4 shrink-0 text-neutral-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-neutral-700">
                        {a.original_name ?? (kind === "video" ? "Video" : "Audio")}
                      </div>
                      {kind === "video" ? (
                        <video
                          controls
                          src={resolveAssetUrl(a.url)}
                          className="mt-1 w-full rounded bg-black"
                          style={{ maxHeight: 120 }}
                        />
                      ) : (
                        <audio
                          controls
                          src={resolveAssetUrl(a.url)}
                          className="mt-1 h-8 w-full"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onPick(a.url)}
                      className="shrink-0 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                    >
                      {active ? "Elegido" : "Elegir"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(a.id)}
                      className="shrink-0 rounded-md p-1.5 text-red-600 hover:bg-red-50"
                      title="Eliminar de la biblioteca"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
