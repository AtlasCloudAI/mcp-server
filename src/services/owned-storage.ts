/**
 * Is this output already on Atlas Cloud's own storage?
 *
 * A finished job does not always come back with an Atlas URL at first. For
 * providers whose delivery network is slow, the platform marks the job completed
 * with the provider's own signed URL and copies the file to Atlas storage in the
 * background a little later. That first URL is a poor thing to hand a user: it
 * expires within a day, and from many networks it downloads at a few hundred KB
 * per second, so an agent that saves it gets a half-written file when its shell
 * returns early. Measured on 2026-10-19: 384 KB in 30 s from the provider URL,
 * then the same 2.3 MB file in 3 s once it was on Atlas storage.
 *
 * Atlas storage is recognised by host: any atlascloud.ai name (custom domains),
 * and Aliyun OSS buckets whose name starts with one of ours. Other OSS buckets
 * are deliberately NOT treated as ours — some upstream providers deliver from
 * Aliyun too, so the `.aliyuncs.com` suffix alone proves nothing.
 *
 * MCP_OWNED_MEDIA_HOSTS adds hosts (comma separated; a leading dot means the
 * domain and everything under it) for storage this list does not know yet.
 */
const OWNED_BUCKET_PREFIXES = ["atlas-media", "atlas-img", "res-atlascloud", "static-atlascloud"];

function extraHosts(): string[] {
  return (process.env.MCP_OWNED_MEDIA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isAtlasStorageUrl(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "atlascloud.ai" || host.endsWith(".atlascloud.ai")) return true;
  if (host.endsWith(".aliyuncs.com")) {
    const bucket = host.split(".")[0] ?? "";
    if (OWNED_BUCKET_PREFIXES.some((p) => bucket === p || bucket.startsWith(`${p}-`))) {
      return true;
    }
  }
  return extraHosts().some((allowed) =>
    allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed
  );
}

/** True when a URL is a media link that has not reached Atlas storage yet. */
export function isPendingTransfer(url: string): boolean {
  return /^https?:\/\//i.test(url) && !isAtlasStorageUrl(url);
}
