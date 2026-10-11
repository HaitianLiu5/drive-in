// The canonical spelling of a video URL is the id of its Source, so history,
// resume positions and track preferences follow the video rather than the
// link: lowercase host, https, no fragment, no tracking parameters, sorted
// query, and one spelling per YouTube video. Changing this changes the keys
// of everything already saved, so keep it stable.

const TRACKING_PARAMS = /^(utm_\w+|si|feature|fbclid|gclid|spm_id_from|vd_source|share_source|share_medium)$/i;

export function canonicalUrl(value) {
  let url = new URL(String(value).trim());
  url.hash = "";
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (url.hostname === "youtu.be" && url.pathname.length > 1) {
    url = new URL(`https://youtube.com/watch?v=${encodeURIComponent(url.pathname.slice(1))}`);
  } else if (url.hostname === "youtube.com" && url.pathname.startsWith("/shorts/")) {
    url = new URL(`https://youtube.com/watch?v=${encodeURIComponent(url.pathname.split("/")[2] || "")}`);
  }
  for (const key of [...url.searchParams.keys()]) {
    // `t` is a start offset, not part of the video's identity.
    if (TRACKING_PARAMS.test(key) || (url.hostname === "youtube.com" && key === "t")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}
