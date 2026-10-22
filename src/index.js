import {appendFileSync} from 'node:fs';
import {convertAll, DEFAULT_VARIANTS} from './convert.js';

function input(name, fallback = '') {
    const value = process.env['INPUT_' + name.replace(/ /g, '_').toUpperCase()];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function setOutput(name, value) {
    if (process.env.GITHUB_OUTPUT) {
        const delimiter = 'hdrjpg_' + Math.random().toString(36).slice(2);
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    }
}

const log = {
    info: (message) => console.log(message),
    warning: (message) => console.log('::warning::' + message),
    error: (message) => console.log('::error::' + message),
};

try {
    const variantsInput = input('variants');
    const result = await convertAll({
        apiKey: input('api-key'),
        patterns: input('source', '**/*.{heic,HEIC,exr,EXR}').split('\n').map((line) => line.trim()).filter(Boolean),
        outputDir: input('output-dir', 'hdr'),
        variants: variantsInput ? JSON.parse(variantsInput) : DEFAULT_VARIANTS,
        apiUrl: input('api-url', 'https://api.hdrjpg.com'),
        pollInterval: Number(input('poll-interval', '3')),
        timeout: Number(input('timeout', '600')),
        concurrency: Number(input('concurrency', '2')),
        log,
    });

    setOutput('converted', String(result.converted.length));
    setOutput('skipped', String(result.skipped.length));
    setOutput('failed', String(result.failed.length));
    setOutput('files', result.files.join('\n'));

    console.log(`HDRJPG: ${result.converted.length} converted, ${result.skipped.length} already up to date, ${result.failed.length} failed`);
    if (result.failed.length > 0 && input('fail-on-error', 'true') !== 'false') {
        process.exitCode = 1;
    }
} catch (error) {
    log.error(error.message);
    process.exitCode = 1;
}
