import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {deflateRawSync, crc32} from 'node:zlib';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {convertAll, namedVariants} from '../src/convert.js';
import {readZip} from '../src/zip.js';

function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [i, [name, content]] of files.entries()) {
        const data = Buffer.from(content);
        const deflate = i % 2 === 1;
        const stored = deflate ? deflateRawSync(data) : data;
        const nameBuffer = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(stored.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuffer, stored);
        centrals.push(central, nameBuffer);
        offset += 30 + nameBuffer.length + stored.length;
    }
    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuffer, end]);
}

/** A stand-in for the HDRJPG API that converts every upload after one status check. */
async function mockApi({key = 'test-key', failFile = null} = {}) {
    const conversions = new Map();
    const calls = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        calls.push(request.method + ' ' + url.pathname);
        const send = (status, body, type = 'application/json') => {
            response.writeHead(status, {'content-type': type});
            response.end(type === 'application/json' ? JSON.stringify(body) : body);
        };
        if (request.headers['api-key'] !== key) {
            return send(401, {errorDescription: 'Invalid API key'});
        }
        if (url.pathname === '/convert') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks).toString('latin1');
            const variants = JSON.parse(body.match(/name="variant"\r\n\r\n(.*)\r\n/)[1]);
            const fileName = body.match(/filename="([^"]+)"/)[1];
            const uuid = 'c' + conversions.size;
            conversions.set(uuid, {variants, fileName, checks: 0});
            return send(200, {conversions: [{uuid, status: 'Pending'}]});
        }
        const conversion = conversions.get(url.searchParams.get('conversionUuid'));
        if (!conversion) {
            return send(404, {errorDescription: 'Conversion not found'});
        }
        if (url.pathname === '/status') {
            conversion.checks++;
            if (conversion.fileName === failFile) {
                return send(200, {conversions: [{uuid: url.searchParams.get('conversionUuid'), status: 'Failed', failDescriptions: ['Source image is not HDR'], variants: []}]});
            }
            return send(200, {conversions: [{uuid: url.searchParams.get('conversionUuid'), status: 'Ready'}]});
        }
        if (url.pathname === '/download') {
            const extensions = {'jpeg-xt': 'jpg', avif: 'avif', mp4: 'mp4', 'jpeg-xl': 'jxl', jpeg: 'sdr.jpg'};
            return send(200, makeZip(conversion.variants.map((v) => [v.fileName + '.' + extensions[v.format], 'data of ' + v.fileName + ' ' + v.format])), 'application/zip');
        }
        send(404, {errorDescription: 'Not found'});
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return {url: 'http://127.0.0.1:' + server.address().port, calls, close: () => server.close()};
}

function workspace(files) {
    const dir = mkdtempSync(join(tmpdir(), 'hdrjpg-action-'));
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), {recursive: true});
        writeFileSync(join(dir, path), content);
    }
    return dir;
}

const quiet = {info() {}, warning() {}, error: process.env.DEBUG ? console.error : () => {}};

test('reads stored and deflated ZIP entries', () => {
    const files = readZip(makeZip([['a.jpg', 'first'], ['b.avif', 'second'.repeat(100)]]));
    assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [['a.jpg', 'first'], ['b.avif', 'second'.repeat(100)]]);
});

test('names variants from the source and size, without collisions', () => {
    assert.deepEqual(
        namedVariants('photos/My Photo.HEIC', [{width: 1600, format: 'jpeg-xt'}, {width: 1600, format: 'avif'}, {width: 1600, format: 'jpeg-xt', baseQuality: 80}, {height: 300, format: 'mp4'}, {format: 'avif', fileName: 'custom'}]).map((v) => v.fileName),
        ['my-photo-1600', 'my-photo-1600', 'my-photo-1600-2', 'my-photo-h300', 'custom'],
    );
});

test('converts matching sources into the output directory, then skips them on the next run', async () => {
    const api = await mockApi();
    const cwd = workspace({'img/sunset.heic': 'heic bytes', 'img/night.exr': 'exr bytes', 'img/readme.txt': 'not an image'});
    try {
        const options = {apiKey: 'test-key', patterns: ['**/*.{heic,exr}'], outputDir: 'hdr', cwd, apiUrl: api.url, pollInterval: 2, log: quiet};
        const first = await convertAll(options);
        assert.deepEqual(first.converted, ['img/night.exr', 'img/sunset.heic']);
        assert.equal(readFileSync(join(cwd, 'hdr/img/sunset-1600.jpg'), 'utf8'), 'data of sunset-1600 jpeg-xt');
        assert.ok(existsSync(join(cwd, 'hdr/img/sunset-1600.avif')));
        assert.ok(existsSync(join(cwd, 'hdr/img/night-1600.mp4')));
        assert.ok(existsSync(join(cwd, 'hdr/.hdrjpg-manifest.json')));

        const callsBefore = api.calls.length;
        const second = await convertAll(options);
        assert.deepEqual(second.skipped, ['img/night.exr', 'img/sunset.heic']);
        assert.equal(api.calls.length, callsBefore, 'a second run with nothing changed makes no API call');

        writeFileSync(join(cwd, 'img/sunset.heic'), 'edited heic bytes');
        const third = await convertAll(options);
        assert.deepEqual(third.converted, ['img/sunset.heic']);
    } finally {
        api.close();
    }
});

test('reports a failed conversion with its reasons and goes on with the others', async () => {
    const api = await mockApi({failFile: 'flat.heic'});
    const cwd = workspace({'flat.heic': 'sdr', 'good.heic': 'hdr'});
    const errors = [];
    try {
        const result = await convertAll({apiKey: 'test-key', patterns: ['*.heic'], outputDir: 'out', cwd, apiUrl: api.url, pollInterval: 2, log: {...quiet, error: (m) => errors.push(m)}});
        assert.deepEqual(result.failed, ['flat.heic']);
        assert.deepEqual(result.converted, ['good.heic']);
        assert.match(errors[0], /flat\.heic: conversion failed: Source image is not HDR/);
    } finally {
        api.close();
    }
});

test('stops at the first rejected API key instead of failing every file', async () => {
    const api = await mockApi();
    const cwd = workspace({'a.heic': '1', 'b.heic': '2', 'c.heic': '3'});
    try {
        const result = await convertAll({apiKey: 'wrong', patterns: ['*.heic'], outputDir: 'out', cwd, apiUrl: api.url, concurrency: 1, log: quiet});
        assert.equal(result.failed.length, 1);
        assert.equal(api.calls.length, 1);
    } finally {
        api.close();
    }
});
