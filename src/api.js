const USER_AGENT = 'hdrjpg-convert-action/1.0.0 (https://hdrjpg.com)';

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * A client for the HDRJPG API: https://hdrjpg.com/documentation/api
 */
export class Api {
    constructor(apiKey, baseUrl = 'https://api.hdrjpg.com') {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    async request(method, endpoint, {query, body} = {}) {
        const url = new URL(this.baseUrl + '/' + endpoint);
        for (const [key, value] of Object.entries(query || {})) {
            url.searchParams.set(key, value);
        }
        let response;
        try {
            response = await fetch(url, {
                method,
                body,
                headers: {'api-key': this.apiKey, 'User-Agent': USER_AGENT},
                // As in the official SDKs: never follow a redirect with the key
                redirect: 'manual',
                signal: AbortSignal.timeout(300_000),
            });
        } catch (error) {
            throw new ApiError('Could not reach the HDRJPG API at ' + url.origin + ': ' + error.message, 0);
        }
        if (!response.ok) {
            let description = response.statusText;
            try {
                description = (await response.json()).errorDescription || description;
            } catch {
                // Not a JSON error body
            }
            throw new ApiError('HDRJPG API ' + endpoint + ' returned ' + response.status + ': ' + description, response.status);
        }
        return response;
    }

    async conversionFrom(response) {
        const data = await response.json();
        const conversion = Array.isArray(data.conversions) ? data.conversions[0] : Object.values(data.conversions || {})[0];
        if (!conversion || !conversion.uuid) {
            throw new ApiError('Unexpected HDRJPG API response: no conversion in it', 0);
        }
        return conversion;
    }

    async submit(fileName, fileData, variants) {
        const form = new FormData();
        form.set('sourceImage', new Blob([fileData]), fileName);
        form.set('variant', JSON.stringify(variants));
        return this.conversionFrom(await this.request('POST', 'convert', {body: form}));
    }

    async status(conversionUuid) {
        return this.conversionFrom(await this.request('GET', 'status', {query: {conversionUuid}}));
    }

    async download(conversionUuid) {
        const response = await this.request('GET', 'download', {query: {conversionUuid}});
        return Buffer.from(await response.arrayBuffer());
    }
}

/**
 * Every error message of a failed conversion and of its variants.
 */
export function failDescriptions(conversion) {
    const descriptions = [...(conversion.failDescriptions || [])];
    for (const variant of Object.values(conversion.variants || {})) {
        for (const description of variant.failDescriptions || []) {
            descriptions.push(description + (variant.outputImageFileName ? ' (' + variant.outputImageFileName + ')' : ''));
        }
    }
    return descriptions;
}
