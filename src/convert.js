import {createHash} from 'node:crypto';
import {existsSync, globSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative, resolve, sep} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Api, failDescriptions} from './api.js';
import {readZip} from './zip.js';

export const DEFAULT_VARIANTS = [
    {width: 1600, format: 'jpeg-xt'},
    {width: 1600, format: 'avif'},
    {width: 1600, format: 'mp4'},
];

const MANIFEST = '.hdrjpg-manifest.json';
const SOURCE_EXTENSIONS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.exr']);

/**
 * Converts every HDR source matched by the patterns, skipping those already converted with the same variants.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string[]} options.patterns Glob patterns, relative to cwd
 * @param {string} options.outputDir Converted files go here, under each source's own relative directory
 * @param {object[]} options.variants As the API's variant parameter
 * @param {string} [options.cwd]
 * @param {string} [options.apiUrl]
 * @param {number} [options.pollInterval] Seconds between status checks, 2 or more
 * @param {number} [options.timeout] Seconds to wait for one conversion
 * @param {number} [options.concurrency] Conversions in flight at once
 * @param {object} [options.log] {info, warning, error}
 * @returns {Promise<{converted: string[], skipped: string[], failed: string[], files: string[]}>}
 */
export async function convertAll({
    apiKey,
    patterns,
    outputDir,
    variants = DEFAULT_VARIANTS,
    cwd = process.cwd(),
    apiUrl = 'https://api.hdrjpg.com',
    pollInterval = 3,
    timeout = 600,
    concurrency = 2,
    log = console,
}) {
    if (!apiKey) {
        throw new Error('The api-key input is empty. Store your HDRJPG API key as a repository secret and pass it as api-key.');
    }
    if (pollInterval < 2) {
        throw new Error('poll-interval must be 2 seconds or more');
    }
    validateVariants(variants);

    const api = new Api(apiKey, apiUrl);
    const outputRoot = resolve(cwd, outputDir);
    const manifestPath = join(outputRoot, MANIFEST);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    const variantsKey = hash(JSON.stringify(variants));

    const sources = findSources(patterns, cwd, outputRoot);
    if (sources.length === 0) {
        log.warning('No HDR source files matched ' + patterns.join(', '));
    }

    const result = {converted: [], skipped: [], failed: [], files: []};
    const queue = [...sources];

    const worker = async () => {
        for (let source = queue.shift(); source; source = queue.shift()) {
            const data = readFileSync(join(cwd, source));
            const sourceKey = hash(data);
            const targetDir = join(outputRoot, dirname(source));
            const previous = manifest[source];

            if (previous && previous.source === sourceKey && previous.variants === variantsKey && previous.files.every((file) => existsSync(join(outputRoot, file)))) {
                log.info(source + ': already converted, skipped');
                result.skipped.push(source);
                result.files.push(...previous.files.map((file) => join(outputDir, file)));
                continue;
            }

            try {
                const files = await convertOne(api, source, data, namedVariants(source, variants), targetDir, {pollInterval, timeout, log});
                const relativeFiles = files.map((file) => relative(outputRoot, file).split(sep).join('/'));
                manifest[source] = {source: sourceKey, variants: variantsKey, files: relativeFiles};
                result.converted.push(source);
                result.files.push(...relativeFiles.map((file) => join(outputDir, file)));
                log.info(source + ': converted into ' + relativeFiles.join(', '));
            } catch (error) {
                result.failed.push(source);
                log.error(source + ': ' + error.message);
                if (error.status === 401 || error.status === 402) {
                    // A bad key or an exhausted quota fails every other file the same way
                    queue.length = 0;
                }
            }
        }
    };
    await Promise.all(Array.from({length: Math.max(1, concurrency)}, worker));

    if (result.converted.length > 0) {
        mkdirSync(outputRoot, {recursive: true});
        writeFileSync(manifestPath, JSON.stringify(sortKeys(manifest), null, 2) + '\n');
    }
    return result;
}

async function convertOne(api, source, data, variants, targetDir, {pollInterval, timeout, log}) {
    let conversion = await api.submit(basename(source), data, variants);
    const uuid = conversion.uuid;
    log.info(source + ': submitted as conversion ' + uuid);

    const deadline = Date.now() + timeout * 1000;
    while (!['Ready', 'Delivered'].includes(conversion.status)) {
        if (['Failed', 'Cancelled', 'Deleted'].includes(conversion.status)) {
            const descriptions = failDescriptions(conversion);
            throw new Error('conversion ' + conversion.status.toLowerCase() + (descriptions.length ? ': ' + descriptions.join(' / ') : ''));
        }
        if (Date.now() > deadline) {
            throw new Error('conversion ' + uuid + ' did not finish within ' + timeout + ' seconds');
        }
        await sleep(pollInterval * 1000);
        conversion = await api.status(uuid);
    }

    mkdirSync(targetDir, {recursive: true});
    const files = [];
    for (const entry of readZip(await api.download(uuid))) {
        // Only the file name is used, so an entry can never be written outside the target directory
        const file = join(targetDir, basename(entry.name));
        writeFileSync(file, entry.data);
        files.push(file);
    }
    if (files.length === 0) {
        throw new Error('the conversion finished but its download is empty');
    }
    return files;
}

function findSources(patterns, cwd, outputRoot) {
    const sources = new Set();
    for (const pattern of patterns) {
        for (const file of globSync(pattern, {cwd})) {
            const absolute = resolve(cwd, file);
            if (SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) && !absolute.startsWith(outputRoot + sep)) {
                sources.add(relative(cwd, absolute).split(sep).join('/'));
            }
        }
    }
    return [...sources].sort();
}

/**
 * Gives each variant without a fileName one built from the source's name and the variant's size, so the
 * outputs of one source never overwrite each other and stay recognisable.
 */
export function namedVariants(source, variants) {
    const base = basename(source, extname(source)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    const used = new Set();
    return variants.map((variant) => {
        if (variant.fileName) {
            return variant;
        }
        const size = variant.width ? '-' + variant.width : variant.height ? '-h' + variant.height : '';
        let fileName = base + size;
        for (let n = 2; used.has(fileName + '|' + variant.format); n++) {
            fileName = base + size + '-' + n;
        }
        used.add(fileName + '|' + variant.format);
        return {...variant, fileName};
    });
}

function validateVariants(variants) {
    if (!Array.isArray(variants) || variants.length === 0) {
        throw new Error('variants must be a JSON array with at least one variant');
    }
    for (const variant of variants) {
        if (!variant || typeof variant !== 'object' || !variant.format) {
            throw new Error('every variant needs a format: jpeg-xt, jpeg-xl, avif, mp4 or jpeg');
        }
    }
}

function hash(data) {
    return createHash('sha256').update(data).digest('hex');
}

function sortKeys(object) {
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}
