export const NO_PREVIEW_ROBOTS = "noindex, nofollow, noarchive, nosnippet, noimageindex";

const SOCIAL_PREVIEW_CRAWLER =
  /\b(Twitterbot|facebookexternalhit|Facebot|TelegramBot|WhatsApp|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|Pinterestbot|Applebot)\b/i;

export const isSocialPreviewCrawler = (request: Request) =>
  SOCIAL_PREVIEW_CRAWLER.test(request.headers.get("user-agent") ?? "");

export const noPreviewHeaders = (contentType?: string) => {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-robots-tag": NO_PREVIEW_ROBOTS
  });
  if (contentType) headers.set("content-type", contentType);
  return headers;
};

export const htmlNoPreviewHeaders = () => noPreviewHeaders("text/html; charset=utf-8");

export const socialPreviewNoContentResponse = () =>
  new Response(null, {
    status: 204,
    headers: noPreviewHeaders()
  });
