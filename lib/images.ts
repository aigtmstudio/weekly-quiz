import { put } from "@vercel/blob";

import { siteUrl } from "@/lib/env";

/**
 * Picture-round images.
 *
 * Resolved through the Wikipedia page-images endpoint, downloaded once at
 * generation time and stored in Vercel Blob. Nothing is hotlinked at render
 * time — the old setup pointed straight at upload.wikimedia.org, which is both
 * rude and fragile.
 *
 * A page with no lead image is a hard failure. Never substitute a different
 * subject's picture for the one the question is about.
 */

const API = "https://en.wikipedia.org/w/api.php";
export const THUMB_SIZE = 420;

/** Wikipedia asks for a descriptive agent with a way to get in touch. */
function userAgent(): string {
  return `PubQuizBrain/1.0 (${siteUrl()}) node-fetch`;
}

export class ImageError extends Error {}

export interface ResolvedImage {
  /** Direct URL of the thumbnail on Wikimedia. */
  sourceUrl: string;
  /** Canonical Wikipedia article the image was taken from. */
  pageTitle: string;
  /** Human-readable attribution, ready to render under the image. */
  credit: string;
}

interface FetchLike {
  (input: string, init?: { headers?: Record<string, string> }): Promise<Response>;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function queryWikipedia(
  params: Record<string, string>,
  doFetch: FetchLike,
): Promise<Record<string, unknown>> {
  const url = `${API}?${new URLSearchParams({
    format: "json",
    formatversion: "2",
    origin: "*",
    ...params,
  })}`;

  const response = await doFetch(url, { headers: { "User-Agent": userAgent() } });
  if (!response.ok) {
    throw new ImageError(`Wikipedia returned ${response.status} for ${params.titles}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Find the lead image for an article. Throws if the article has none, or does
 * not exist — the caller is expected to pick a different subject.
 */
export async function resolveImage(
  articleTitle: string,
  doFetch: FetchLike = fetch,
): Promise<ResolvedImage> {
  const data = await queryWikipedia(
    {
      action: "query",
      prop: "pageimages",
      piprop: "thumbnail|name",
      pithumbsize: String(THUMB_SIZE),
      titles: articleTitle,
      redirects: "1",
    },
    doFetch,
  );

  const pages = (data.query as { pages?: unknown[] } | undefined)?.pages;
  const page = Array.isArray(pages) ? (pages[0] as Record<string, unknown>) : undefined;

  if (!page || page.missing) {
    throw new ImageError(`No Wikipedia article named "${articleTitle}"`);
  }

  const thumbnail = page.thumbnail as { source?: string } | undefined;
  if (!thumbnail?.source) {
    throw new ImageError(`"${articleTitle}" has no lead image — choose another subject`);
  }

  const pageTitle = String(page.title ?? articleTitle);
  const fileName = page.pageimage ? String(page.pageimage) : null;

  return {
    sourceUrl: thumbnail.source,
    pageTitle,
    credit: await resolveCredit(fileName, pageTitle, doFetch),
  };
}

async function resolveCredit(
  fileName: string | null,
  pageTitle: string,
  doFetch: FetchLike,
): Promise<string> {
  const fallback = `Wikipedia — ${pageTitle}`;
  if (!fileName) return fallback;

  try {
    const data = await queryWikipedia(
      {
        action: "query",
        prop: "imageinfo",
        iiprop: "extmetadata",
        iiextmetadatafilter: "Artist|LicenseShortName",
        titles: `File:${fileName}`,
      },
      doFetch,
    );

    const pages = (data.query as { pages?: unknown[] } | undefined)?.pages;
    const page = Array.isArray(pages) ? (pages[0] as Record<string, unknown>) : undefined;
    const info = (page?.imageinfo as Array<Record<string, unknown>> | undefined)?.[0];
    const meta = info?.extmetadata as
      | Record<string, { value?: string } | undefined>
      | undefined;

    const artist = meta?.Artist?.value ? stripHtml(meta.Artist.value) : null;
    const licence = meta?.LicenseShortName?.value
      ? stripHtml(meta.LicenseShortName.value)
      : null;

    const parts = [artist, licence].filter(Boolean);
    return parts.length ? `${parts.join(", ")} — via Wikipedia` : fallback;
  } catch {
    // Attribution is worth having but not worth failing a quiz over.
    return fallback;
  }
}

function extensionFor(url: string): string {
  const match = /\.(jpe?g|png|gif|webp|svg)(?:$|\?)/i.exec(url);
  return match ? match[1].toLowerCase() : "jpg";
}

/**
 * Resolve an article's lead image and store it in Blob.
 *
 * `slug` becomes the stored filename, so regenerating a quiz overwrites rather
 * than accumulating copies.
 */
export async function storeImage(
  articleTitle: string,
  slug: string,
  doFetch: FetchLike = fetch,
): Promise<{ imagePath: string; imageCredit: string }> {
  const resolved = await resolveImage(articleTitle, doFetch);

  const response = await doFetch(resolved.sourceUrl, {
    headers: { "User-Agent": userAgent() },
  });
  if (!response.ok) {
    throw new ImageError(
      `Could not download image for "${articleTitle}": ${response.status}`,
    );
  }

  const body = await response.arrayBuffer();
  const blob = await put(
    `quiz-images/${slug}.${extensionFor(resolved.sourceUrl)}`,
    Buffer.from(body),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: response.headers.get("content-type") ?? undefined,
    },
  );

  return { imagePath: blob.url, imageCredit: resolved.credit };
}
