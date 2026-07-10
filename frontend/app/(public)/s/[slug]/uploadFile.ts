// Upload a respondent's file (video/image) straight to storage via a presigned
// URL, so big files never touch our server. Returns the file's public URL.
// Shared by SurveyJS's onUploadFiles handler and the custom video recorder.
import { getApiUrl } from "@/utils/api";

export async function uploadRespondentFile(
  slug: string,
  file: Blob & { type: string; size: number }
): Promise<string> {
  const pre = await fetch(
    getApiUrl(`/api/v1/survey/public/${encodeURIComponent(slug)}/upload-url`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: file.type, size: file.size }),
    }
  );
  if (!pre.ok) throw new Error(await pre.text().catch(() => "upload-url failed"));
  const { upload_url, method, headers, public_url } = await pre.json();
  // Storage local devuelve una URL RELATIVA (/api/v1/uploads/local…) → se resuelve
  // contra la base de la API (backend en dev, mismo-origen en producción). S3
  // devuelve una URL absoluta al bucket → se usa tal cual.
  const putUrl = upload_url.startsWith("/") ? getApiUrl(upload_url) : upload_url;
  const put = await fetch(putUrl, { method, headers, body: file });
  if (!put.ok) throw new Error("PUT failed");
  return public_url as string;
}
