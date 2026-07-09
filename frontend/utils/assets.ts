// Typed client for the per-organization media library. Uploads go through
// multipart/form-data (never JSON); the API returns a relative /assets/… URL
// that we persist as-is (resolveAssetUrl absolutizes only at render time).

import { getApiUrl } from "@/utils/api";

export type AssetKind = "image" | "audio" | "video";

export interface Asset {
  id: string;
  kind: AssetKind;
  url: string; // relative, e.g. /assets/…
  content_type: string;
  size: number;
  original_name: string | null;
  created_at: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.clone().json();
    if (data && typeof data === "object") {
      const detail = (data as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) return detail;
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/** Upload a file to the media library. Uses FormData + credentials. */
export async function uploadAsset(file: File): Promise<Asset> {
  const body = new FormData();
  body.append("file", file);
  // Do NOT set Content-Type manually: the browser adds the multipart boundary.
  const res = await fetch(getApiUrl("/api/v1/assets"), {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await readError(res, "No se pudo subir el archivo."));
  }
  return (await res.json()) as Asset;
}

/** List assets in the library, optionally filtered by kind. */
export async function listAssets(kind?: AssetKind): Promise<Asset[]> {
  const path = kind ? `/api/v1/assets?kind=${kind}` : "/api/v1/assets";
  const res = await fetch(getApiUrl(path), { credentials: "include" });
  if (!res.ok) {
    throw new Error(await readError(res, "No se pudo cargar la biblioteca."));
  }
  return (await res.json()) as Asset[];
}

/** Delete an asset from the library. */
export async function deleteAsset(id: string): Promise<void> {
  const res = await fetch(getApiUrl(`/api/v1/assets/${id}`), {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(await readError(res, "No se pudo eliminar el archivo."));
  }
}
