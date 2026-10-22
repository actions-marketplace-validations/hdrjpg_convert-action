import {inflateRawSync} from 'node:zlib';

/**
 * Reads the files in a ZIP archive, as the HDRJPG API's /download endpoint returns it.
 * Handles stored and deflated entries, which is what the API writes; ZIP64 archives are refused.
 *
 * @param {Buffer} buffer
 * @returns {{name: string, data: Buffer}[]}
 */
export function readZip(buffer) {
    const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
    const entryCount = buffer.readUInt16LE(endOfCentralDirectory + 10);
    let offset = buffer.readUInt32LE(endOfCentralDirectory + 16);
    if (offset === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
    }

    const files = [];
    for (let i = 0; i < entryCount; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Corrupt ZIP archive: bad central directory entry');
        }
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        if (name.endsWith('/')) {
            continue;
        }
        if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            throw new Error('ZIP64 archives are not supported');
        }
        if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error('Corrupt ZIP archive: bad local header for ' + name);
        }
        const dataStart = localHeaderOffset + 30 + buffer.readUInt16LE(localHeaderOffset + 26) + buffer.readUInt16LE(localHeaderOffset + 28);
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

        let data;
        if (method === 0) {
            data = Buffer.from(compressed);
        } else if (method === 8) {
            data = inflateRawSync(compressed);
        } else {
            throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name);
        }
        files.push({name, data});
    }
    return files;
}

function findEndOfCentralDirectory(buffer) {
    // The record is 22 bytes plus a comment of up to 65535 bytes, at the end of the file
    const lowest = Math.max(0, buffer.length - 22 - 0xffff);
    for (let offset = buffer.length - 22; offset >= lowest; offset--) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }
    throw new Error('Not a ZIP archive');
}
