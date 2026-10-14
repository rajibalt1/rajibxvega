import { ProviderContext } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { throwProviderError } from "../providerErrors";

function rot13(str: string) {
  return str.replace(/[a-zA-Z]/g, function (char) {
    const charCode = char.charCodeAt(0);
    const isUpperCase = char <= "Z";
    const baseCharCode = isUpperCase ? 65 : 97;
    return String.fromCharCode(
      ((charCode - baseCharCode + 13) % 26) + baseCharCode,
    );
  });
}

const safeAtob = (str: string): string | null => {
  if (!str) return null;
  try {
    const cleanStr = str.trim().replace(/-/g, "+").replace(/_/g, "/");
    const pad = cleanStr.length % 4;
    const padded = pad ? cleanStr + "=".repeat(4 - pad) : cleanStr;
    if (typeof atob === "function") {
      return atob(padded);
    }
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch (e) {
    return null;
  }
};

export function decodeString(encryptedString: string) {
  if (!encryptedString) return null;
  try {
    // First base64 decode
    let decoded = safeAtob(encryptedString);
    if (!decoded) return null;
    // Second base64 decode
    decoded = safeAtob(decoded);
    if (!decoded) return null;
    // ROT13 decode
    decoded = rot13(decoded);
    // Third base64 decode
    decoded = safeAtob(decoded);
    if (!decoded) return null;
    // Parse JSON
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}

function extractEncryptedPayload(text: string): string {
  // Method 1: Match s('o','...') or ck('_wp_http_...','...')
  const regex = /s\('o',\s*'([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+',\s*'([^']+)'/g;
  let combined = "";
  let match;
  while ((match = regex.exec(text)) !== null) {
    combined += match[1] || match[2] || "";
  }
  if (combined) return combined;

  // Method 2: Fallback split
  return text.split("s('o','")?.[1]?.split("',")?.[0] || "";
}

async function resolveHubdrive(
  url: string,
  axios: any,
  cheerio: any,
  headers: any,
  signal: AbortSignal,
): Promise<string> {
  try {
    const res = await axios.get(url, { headers, signal });
    const $ = cheerio.load(res.data || "");
    return (
      $('a[href*="hubcloud"]').attr("href") ||
      $(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href") ||
      $(".btn.btn-primary.btn-user.btn-success1").attr("href") ||
      $("a#download").attr("href") ||
      url
    );
  } catch {
    return url;
  }
}

export async function getStream({
  link,
  type,
  signal,
  providerContext,
  isDownload,
}: {
  link: string;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}) {
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  let hubdriveLink = "";

  // 1. Direct HubCloud / VCloud link check
  if (
    link.includes("hubcloud") ||
    link.includes("vcloud") ||
    link.includes("/drive/")
  ) {
    return await hubcloudExtractor(
      link,
      signal,
      axios,
      cheerio,
      headers,
      providerContext,
      isDownload,
      "hdhub4u",
    );
  }

  // 2. Direct HubDrive link check
  if (link.includes("hubdrive")) {
    hubdriveLink = await resolveHubdrive(link, axios, cheerio, headers, signal);
  } else {
    let currentLink = link;
    let text = "";

    try {
      const res = await axios.get(currentLink, { headers, signal });
      text = res.data || "";

      // Check for reurl in script
      const reurlMatch = text.match(/var\s+reurl\s*=\s*["']([^"']+)["']/i);
      if (reurlMatch?.[1]) {
        currentLink = reurlMatch[1];
        const res2 = await axios.get(currentLink, {
          headers: { ...headers, Referer: link },
          signal,
        });
        text = res2.data || "";
      }

      // Check for encrypted payload (s('o',...) or ck('_wp_http_...'))
      const encryptedString = extractEncryptedPayload(text);
      if (encryptedString) {
        const decoded = decodeString(encryptedString);
        const rawTarget = decoded?.o ? safeAtob(decoded.o) : null;
        const nextUrl = rawTarget?.trim() || decoded?.link || "";

        if (nextUrl) {
          currentLink = nextUrl;

          // Short-circuit if decoded URL is already a HubCloud/VCloud link
          if (
            currentLink.includes("hubcloud") ||
            currentLink.includes("vcloud") ||
            currentLink.includes("/drive/")
          ) {
            return await hubcloudExtractor(
              currentLink,
              signal,
              axios,
              cheerio,
              headers,
              providerContext,
              isDownload,
              "hdhub4u",
            );
          }

          const res3 = await axios.get(currentLink, {
            headers: { ...headers, Referer: link },
            signal,
          });
          text = res3.data || "";
        }
      }
    } catch {
      // fallback to parsing whatever text/currentLink we have
    }

    const $ = cheerio.load(text);

    // Direct R2 / HubCDN stream check
    const directR2 =
      $('a[href*="r2.dev"]').attr("href") ||
      $('a[href*="hubcdn.fans"]').attr("href") ||
      $('a#vd').attr("href");
    if (directR2 && (directR2.includes(".mkv") || directR2.includes(".mp4") || directR2.includes("r2.dev"))) {
      return [
        {
          server: "HubCDN",
          link: directR2,
          type: "mkv",
        },
      ];
    }

    const driveLinks: { quality: string; link: string }[] = [];
    $(
      'a[href*="hubcloud"], a[href*="vcloud"], a[href*="hubdrive"]',
    ).each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const t =
        $(el).text().toLowerCase() +
        $(el).parent().text().toLowerCase() +
        $(el).parent().parent().text().toLowerCase();

      let quality = "Unknown";
      if (t.includes("2160p") || t.includes("4k")) quality = "4k";
      else if (t.includes("1080p")) quality = "1080p";
      else if (t.includes("720p")) quality = "720p";
      else if (t.includes("480p")) quality = "480p";

      driveLinks.push({ quality, link: href });
    });

    const qualityOrder: Record<string, number> = {
      "4k": 4,
      "1080p": 3,
      "720p": 2,
      "480p": 1,
      Unknown: 0,
    };
    driveLinks.sort((a, b) => qualityOrder[b.quality] - qualityOrder[a.quality]);

    hubdriveLink =
      driveLinks[0]?.link ||
      text.match(/href=["'](https?:\/\/(?:hubcloud|vcloud)\.[^\/"']+\/drive\/[^"']+)["']/i)?.[1] ||
      "";

    if (
      !hubdriveLink &&
      (currentLink.includes("hubcloud") ||
        currentLink.includes("vcloud") ||
        currentLink.includes("hubdrive"))
    ) {
      hubdriveLink = currentLink;
    }

    if (hubdriveLink.includes("hubdrive")) {
      hubdriveLink = await resolveHubdrive(
        hubdriveLink,
        axios,
        cheerio,
        headers,
        signal,
      );
    }
  }

  let hubcloudLink = hubdriveLink;
  try {
    if (hubdriveLink && !hubdriveLink.includes("/drive/")) {
      const hubdriveLinkRes = await axios.get(hubdriveLink, { headers, signal });
      const hubcloudText = hubdriveLinkRes.data || "";
      hubcloudLink =
        hubcloudText.match(
          /<META HTTP-EQUIV="refresh" content="0;\s*url=([^"]+)">/i,
        )?.[1] || hubdriveLink;
    }
  } catch {
    // ignore
  }

  try {
    return await hubcloudExtractor(
      hubcloudLink || link,
      signal,
      axios,
      cheerio,
      headers,
      providerContext,
      isDownload,
      "hdhub4u",
    );
  } catch (error: any) {
    throwProviderError("HDHub4u", "stream", error);
  }
    }
