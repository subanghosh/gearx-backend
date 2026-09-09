/**
 * ReDrivo Cloudflare R2 Storage Adapter
 * Provides zero-disk in-memory uploads, private bucket security,
 * automatic encryption at rest, and time-limited presigned URL generation.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');

let s3ClientInstance = null;

function isR2Configured() {
    return !!(
        process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET_NAME
    );
}

function getR2Client() {
    if (!isR2Configured()) {
        return null;
    }
    if (!s3ClientInstance) {
        const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
        const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
        const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
        const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

        s3ClientInstance = new S3Client({
            region: process.env.R2_REGION || 'auto',
            endpoint: endpoint,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey
            },
            forcePathStyle: true
        });
    }
    return s3ClientInstance;
}

function normalizeKey(keyOrPath) {
    if (!keyOrPath || typeof keyOrPath !== 'string') return '';
    let key = keyOrPath.trim();
    key = key.split('?')[0];
    if (key.startsWith('http://') || key.startsWith('https://')) {
        try {
            const parsed = new URL(key);
            key = parsed.pathname;
        } catch (e) {
            key = key.replace(/^https?:\/\/[^\/]+/, '');
        }
    }
    key = key.replace(/^\/+/, '');
    return key;
}

/**
 * Upload an in-memory buffer directly to Cloudflare R2
 */
async function uploadBufferToR2({ key, buffer, mimetype, metadata = {} }) {
    const client = getR2Client();
    if (!client) {
        throw new Error('Cloudflare R2 is not configured. Missing R2 environment variables.');
    }

    const cleanKey = normalizeKey(key);
    const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

    const putParams = {
        Bucket: bucketName,
        Key: cleanKey,
        Body: buffer,
        ContentType: mimetype || 'application/octet-stream',
        Metadata: metadata
    };

    const command = new PutObjectCommand(putParams);
    const response = await client.send(command);

    return {
        success: true,
        key: cleanKey,
        bucket: bucketName,
        size: buffer.length,
        etag: response.ETag,
        uploadedAt: new Date().toISOString()
    };
}

/**
 * Generate a secure, time-limited presigned GET URL for a private R2 object
 */
async function getPresignedDocUrl(keyOrPath, expirySeconds = 900) {
    if (!keyOrPath || typeof keyOrPath !== 'string') return keyOrPath;
    if (keyOrPath.startsWith('data:')) return keyOrPath;

    const cleanKey = normalizeKey(keyOrPath);
    if (!cleanKey) return keyOrPath;

    const client = getR2Client();
    if (!client) {
        return null;
    }

    const bucketName = (process.env.R2_BUCKET_NAME || '').trim();
    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
    });

    return await getSignedUrl(client, command, { expiresIn: expirySeconds });
}

/**
 * Inspect object headers / metadata in R2
 */
async function headR2Object(keyOrPath) {
    const client = getR2Client();
    if (!client) throw new Error('Cloudflare R2 is not configured.');

    const cleanKey = normalizeKey(keyOrPath);
    const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

    const command = new HeadObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
    });

    return await client.send(command);
}

/**
 * Delete an object from R2
 */
async function deleteFromR2(keyOrPath) {
    const client = getR2Client();
    if (!client) return false;

    const cleanKey = normalizeKey(keyOrPath);
    const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

    const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
    });

    await client.send(command);
    return true;
}

/**
 * Stream an object from R2 (for backend proxying if needed)
 */
async function getR2ObjectStream(keyOrPath) {
    const client = getR2Client();
    if (!client) throw new Error('Cloudflare R2 is not configured.');

    const cleanKey = normalizeKey(keyOrPath);
    const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: cleanKey
    });

    return await client.send(command);
}

module.exports = {
    isR2Configured,
    getR2Client,
    uploadBufferToR2,
    getPresignedDocUrl,
    headR2Object,
    deleteFromR2,
    getR2ObjectStream,
    normalizeKey
};
