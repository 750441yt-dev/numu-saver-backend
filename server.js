require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

// Link fluent-ffmpeg to the automatically downloaded ffmpeg-static binary
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

// Security: Unrestricted CORS to prevent ANY blocking on Blogger
app.use(cors());
app.use(express.json());

// Setup a safe temporary directory for Muxed Files
const TEMP_DIR = path.join(os.tmpdir(), 'numu_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Clean up processed files to save server space (1 Hour Delay)
const deleteFileAfterDelay = (filePath, delay = 60 * 60 * 1000) => {
    setTimeout(() => {
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                console.error(`Failed to delete file: ${filePath}`, e);
            }
        }
    }, delay);
};

// URL Validator
function isValidInstagramUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        return parsed.hostname.includes('instagram.com');
    } catch (e) {
        return false;
    }
}

// Helper: Download a file stream directly to local disk using Axios (With Anti-Block Headers)
const downloadFile = async (url, destPath) => {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://www.instagram.com/'
        },
        timeout: 60000 // Extended timeout for downloading large Reels
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

// FFmpeg Muxer logic for merging Instagram Video + Audio
const muxMediaLocally = (localVideo, localAudio, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(localVideo)
            .input(localAudio)
            .outputOptions([
                '-c:v copy',             // Copy original video stream
                '-c:a aac',              // Encode audio to universal AAC
                '-map 0:v:0',            // Strictly map video
                '-map 1:a:0',            // Strictly map audio
                '-shortest',             // End encoding when shortest stream ends
                '-movflags +faststart'   // Optimize MP4
            ])
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
};

// ==========================================
// HEALTH ENDPOINT
// ==========================================
app.get('/health', (req, res) => {
    res.json({ success: true, service: "NUMU SAVER Backend is Awake" });
});

// ==========================================
// FORCED DOWNLOAD ROUTES
// ==========================================
app.get('/downloads/:filename', (req, res) => {
    const filepath = path.join(TEMP_DIR, req.params.filename);
    if (fs.existsSync(filepath)) {
        res.download(filepath, 'NUMU-SAVER-Reel.mp4', (err) => {
            if (err) console.error("Error sending file:", err);
        });
    } else {
        res.status(404).send('Download link expired or file unavailable. Please fetch the video again.');
    }
});

// Proxy route for unified media files (Anti-Block)
app.get('/api/proxy', async (req, res) => {
    try {
        const videoUrl = req.query.url;
        if (!videoUrl) return res.status(400).send('No URL provided');

        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Referer': 'https://www.instagram.com/'
            }
        });

        res.setHeader('Content-Disposition', 'attachment; filename="NUMU-SAVER-Reel.mp4"');
        res.setHeader('Content-Type', 'video/mp4');
        response.data.pipe(res);
    } catch (err) {
        console.error("Proxy error:", err.message);
        res.status(500).send('Error downloading file from Instagram Servers.');
    }
});

// ==========================================
// MAIN INSTAGRAM EXTRACTION ENDPOINT
// ==========================================
app.post('/api/instagram/extract', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || !isValidInstagramUrl(url)) {
            return res.status(400).json({ success: false, error: "Invalid Instagram URL provided. Check your link." });
        }
        if (!process.env.APIFY_API_TOKEN) {
            return res.status(500).json({ success: false, error: "Backend error: APIFY_API_TOKEN is missing in Render." });
        }

        const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
        
        // Fixed Apify Call (Removed restricting parameters)
        const run = await client.actor("apify/instagram-scraper").call({
            directUrls: [url]
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        if (!items || items.length === 0) {
            return res.status(404).json({ success: false, error: "Instagram post not found or it is a Private Account." });
        }

        const mediaData = items[0];
        const formats = [];
        
        let videoUrl = mediaData.videoUrl || mediaData.video_url;
        let audioUrl = mediaData.audioUrl || mediaData.audio_url; 

        // If direct videoUrl isn't available, search versions
        if (!videoUrl && mediaData.videoVersions && mediaData.videoVersions.length > 0) {
            const sortedVids = [...mediaData.videoVersions].sort((a, b) => (b.width || 0) - (a.width || 0));
            videoUrl = sortedVids[0].url;
        }
        if (!audioUrl && mediaData.audioVersions && mediaData.audioVersions.length > 0) {
            audioUrl = mediaData.audioVersions[0].url;
        }

        if (!videoUrl) {
            return res.status(404).json({ success: false, error: "No video found. Make sure the URL is a Video or Reel, not a Photo." });
        }

        // MUXING LOGIC TO GUARANTEE MUSIC/AUDIO
        if (videoUrl && audioUrl && videoUrl !== audioUrl) {
            const fileId = crypto.randomUUID();
            const videoTemp = path.join(TEMP_DIR, `v_${fileId}.mp4`);
            const audioTemp = path.join(TEMP_DIR, `a_${fileId}.mp4`);
            const outputPath = path.join(TEMP_DIR, `numu_ig_${fileId}.mp4`);

            try {
                await downloadFile(videoUrl, videoTemp);
                await downloadFile(audioUrl, audioTemp);
                await muxMediaLocally(videoTemp, audioTemp, outputPath);
                
                if (fs.existsSync(videoTemp)) fs.unlinkSync(videoTemp);
                if (fs.existsSync(audioTemp)) fs.unlinkSync(audioTemp);
            } catch (muxError) {
                console.error("Critical Muxing Failure:", muxError);
                if (fs.existsSync(videoTemp)) fs.unlinkSync(videoTemp);
                if (fs.existsSync(audioTemp)) fs.unlinkSync(audioTemp);
                return res.status(500).json({ success: false, error: "Failed to extract audio track. Instagram blocked the stream." });
            }

            deleteFileAfterDelay(outputPath, 60 * 60 * 1000); 
            formats.push({ quality: "Original HD (Video + Music)", url: `/downloads/numu_ig_${fileId}.mp4` });
        } else {
            // Single unified file. Proxy it through backend
            formats.push({ quality: "Original HD (Video + Music)", url: `/api/proxy?url=${encodeURIComponent(videoUrl)}` });
        }

        return res.json({ s
