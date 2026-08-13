import { describe, expect, it, vi } from "vitest";

import { ImageError, THUMB_SIZE, resolveImage } from "@/lib/images";

/**
 * Wikipedia is stubbed throughout — these tests never touch the network.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pageImagesResponse(page: Record<string, unknown>) {
  return jsonResponse({ query: { pages: [page] } });
}

const WITH_IMAGE = {
  title: "Sutton Hoo",
  pageimage: "Sutton_Hoo_helmet.jpg",
  thumbnail: { source: "https://upload.wikimedia.org/thumb/helmet.jpg", width: 420 },
};

describe("resolveImage", () => {
  it("returns the thumbnail for an article that has a lead image", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes("pageimages")
        ? pageImagesResponse(WITH_IMAGE)
        : jsonResponse({
            query: {
              pages: [
                {
                  imageinfo: [
                    {
                      extmetadata: {
                        Artist: { value: "<a href='#'>Rob Roy</a>" },
                        LicenseShortName: { value: "CC BY-SA 4.0" },
                      },
                    },
                  ],
                },
              ],
            },
          }),
    );

    const image = await resolveImage("Sutton Hoo", fetcher);

    expect(image.sourceUrl).toBe(WITH_IMAGE.thumbnail.source);
    expect(image.pageTitle).toBe("Sutton Hoo");
    // HTML in the attribution metadata is stripped, not passed through.
    expect(image.credit).toBe("Rob Roy, CC BY-SA 4.0 — via Wikipedia");
  });

  it("fails rather than substituting when the article has no lead image", async () => {
    const fetcher = vi.fn(async () => pageImagesResponse({ title: "Some Concept" }));

    await expect(resolveImage("Some Concept", fetcher)).rejects.toThrow(ImageError);
    await expect(resolveImage("Some Concept", fetcher)).rejects.toThrow(/no lead image/);
  });

  it("fails when the article does not exist", async () => {
    const fetcher = vi.fn(async () =>
      pageImagesResponse({ title: "Nonsense", missing: true }),
    );

    await expect(resolveImage("Nonsense", fetcher)).rejects.toThrow(/No Wikipedia article/);
  });

  it("requests the agreed thumbnail size and identifies itself", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: { headers?: Record<string, string> }) =>
        pageImagesResponse(WITH_IMAGE),
    );

    await resolveImage("Sutton Hoo", fetcher);

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toContain(`pithumbsize=${THUMB_SIZE}`);
    // Wikipedia asks for a descriptive User-Agent on every request.
    expect(init?.headers?.["User-Agent"]).toMatch(/PubQuizBrain/);
  });

  it("falls back to a plain credit when the licence lookup fails", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("pageimages")) return pageImagesResponse(WITH_IMAGE);
      throw new Error("network down");
    });

    const image = await resolveImage("Sutton Hoo", fetcher);

    expect(image.credit).toBe("Wikipedia — Sutton Hoo");
  });

  it("surfaces an HTTP failure rather than returning nothing", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 503 }));

    await expect(resolveImage("Sutton Hoo", fetcher)).rejects.toThrow(/503/);
  });
});
