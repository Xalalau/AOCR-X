const OCR_MEDIA_PATH_PATTERN = /\.(?:avif|bmp|gif|jpe?g|m4v|mov|mp4|png|tiff?|webm|webp)$/i;

type UrlCollection = Set<string>;

type AttachmentCandidate = {
	url?: string | null;
	contentType?: string | null;
};

type EmbedImageCandidate = {
	url?: string | null;
};

type EmbedVideoCandidate = {
	url?: string | null;
	proxyURL?: string | null;
	proxy_url?: string | null;
};

type EmbedCandidate = {
	image?: EmbedImageCandidate | null;
	thumbnail?: EmbedImageCandidate | null;
	video?: EmbedVideoCandidate | null;
};

function isDiscordCdnHost(hostname: string) {
	return (
		hostname === "cdn.discordapp.com" ||
		hostname === "media.discordapp.net"
	);
}

function isOcrMediaContentType(contentType?: string | null) {
	const normalizedContentType = contentType?.toLowerCase();
	return Boolean(
		normalizedContentType?.startsWith("image/") ||
			normalizedContentType?.startsWith("video/"),
	);
}

export function isLikelyDirectImageUrl(rawUrl: string) {
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return false;
		}

		if (OCR_MEDIA_PATH_PATTERN.test(url.pathname)) {
			return true;
		}

		return isDiscordCdnHost(url.hostname);
	} catch {
		return false;
	}
}

export function addLikelyImageUrl(urls: UrlCollection, rawUrl?: string | null) {
	if (!rawUrl || !isLikelyDirectImageUrl(rawUrl)) {
		return false;
	}

	urls.add(rawUrl);
	return true;
}

function addFirstLikelyImageUrl(
	urls: UrlCollection,
	...rawUrls: Array<string | null | undefined>
) {
	for (const rawUrl of rawUrls) {
		if (addLikelyImageUrl(urls, rawUrl)) {
			return true;
		}
	}

	return false;
}

export function isImageAttachment(attachment: AttachmentCandidate) {
	if (isOcrMediaContentType(attachment.contentType)) {
		return true;
	}

	return typeof attachment.url === "string" && isLikelyDirectImageUrl(attachment.url);
}

export function addAttachmentImageUrl(
	urls: UrlCollection,
	attachment: AttachmentCandidate,
) {
	if (!isImageAttachment(attachment) || !attachment.url) {
		return false;
	}

	urls.add(attachment.url);
	return true;
}

export function addEmbedImageUrls(urls: UrlCollection, embed: EmbedCandidate) {
	const before = urls.size;
	addLikelyImageUrl(urls, embed.image?.url);
	addLikelyImageUrl(urls, embed.thumbnail?.url);
	addFirstLikelyImageUrl(
		urls,
		embed.video?.proxyURL,
		embed.video?.proxy_url,
		embed.video?.url,
	);
	return urls.size > before;
}

export function hasEmbedImageUrl(embed: EmbedCandidate) {
	return Boolean(
		(embed.image?.url && isLikelyDirectImageUrl(embed.image.url)) ||
			(embed.thumbnail?.url && isLikelyDirectImageUrl(embed.thumbnail.url)) ||
			(embed.video?.proxyURL && isLikelyDirectImageUrl(embed.video.proxyURL)) ||
			(embed.video?.proxy_url && isLikelyDirectImageUrl(embed.video.proxy_url)) ||
			(embed.video?.url && isLikelyDirectImageUrl(embed.video.url)),
	);
}
