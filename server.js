require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

// Link FFmpeg & FFprobe to downloaded binaries
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;

// Security: Unrestricted CORS
app.use(cors());
app.use(express.json());

// Setup a safe temporary directory
const TEMP_DIR = path.join(os.tmpdir(), 'numu_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Clean up files after 1 hour
const deleteFileAfterDelay = (filePath, delay = 60 * 60 * 1000) => {
    setTimeout(() => {
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) { }
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

// Helper: Download a file stream directly to local disk
const downloadFile = async (url, destPath) => {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://www.instagram.com/'
        },
        timeout: 60000 
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
};

// NEW HELPER: Smart Audio Detection (To Preserve Real Music)
const hasAudioStream = (videoUrl) => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoUrl, (err, metadata) => {
            if (err) {
                console.error("FFprobe check error:", err.message);
                resolve(true); // Default to true so we don't accidentally ruin the real music
            } else {
                const hasAudio = metadata.streams.some(s => s.codec_type === 'audio');
                resolve(hasAudio);
            }
        });
    });
};

// FFmpeg Muxer
const muxMediaLocally = (localVideo, localAudio, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(localVideo)
            .input(localAudio)
            .outputOptions([
                '-c:v copy',             
                '-c:a aac',              
                '-map 0:v:0',            
                '-map 1:a:0',            
                '-shortest',             
                '-movflags +faststart'   
            ])
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
};

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({ success: true, service: "NUMU SAVER Backend is Awake" });
});

// Serve the fully processed MP4 files
app.get('/downloads/:filename', (req, res) => {
    const filepath = path.join(TEMP_DIR, req.params.filename);
    if (fs.existsSync(filepath)) {
        res.download(filepath, 'NUMU-SAVER-Reel.mp4');
    } else {
        res.status(404).send('Download link expired or file unavailable. Please fetch the video again.');
    }
});

// Proxy route (Forces browser download and preserves original Real Music)
app.get('/api/proxy', async (req, res) => {
    try {
        const videoUrl = req.query.url;
        if (!videoUrl) return res.status(400).send('No URL provided');

        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
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
            return res.status(400).json({ success: false, error: "Invalid Instagram URL provided." });
        }
        if (!process.env.APIFY_API_TOKEN) {
            return res.status(500).json({ success: false, error: "Backend config error." });
        }

        const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
        
        const run = await client.actor("apify/instagram-scraper").call({
            directUrls: [url]
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        if (!items || items.length === 0) {
            return res.status(404).json({ success: false, error: "Post not found or is Private." });
        }

        const mediaData = items[0];
        const formats = [];
        
        let videoUrl = mediaData.videoUrl || mediaData.video_url;
        let audioUrl = mediaData.audioUrl || mediaData.audio_url; 

        if (!videoUrl && mediaData.videoVersions && mediaData.videoVersions.length > 0) {
            const sortedVids = [...mediaData.videoVersions].sort((a, b) => (b.width || 0) - (a.width || 0));
            videoUrl = sortedVids[0].url;
        }
        if (!audioUrl && mediaData.audioVersions && mediaData.audioVersions.length > 0) {
            audioUrl = mediaData.audioVersions[0].url;
        }

        if (!videoUrl) {
            return res.status(404).json({ success: false, error: "No video found in this URL." });
        }

        // SMART AUDIO CHECK: Does the main video already have the Real Music?
        const videoHasRealMusic = await hasAudioStream(videoUrl);

        if (!videoHasRealMusic && audioUrl && videoUrl !== audioUrl) {
            // ONLY merge if video is 100% mute (Rare DASH streams)
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
                console.error("Muxing Failure:", muxError);
                if (fs.existsSync(videoTemp)) fs.unlinkSync(videoTemp);
                if (fs.existsSync(audioTemp)) fs.unlinkSync(audioTemp);
                return res.status(500).json({ success: false, error: "Failed to process media." });
            }

            deleteFileAfterDelay(outputPath, 60 * 60 * 1000); 
            formats.push({ quality: "Original HD (Video + Audio)", url: `/downloads/numu_ig_${fileId}.mp4` });
        } else {
            // PRESERVE REAL MUSIC: Proxy the original file directly!
            formats.push({ quality: "Original HD (Real Music Preserved)", url: `/api/proxy?url=${encodeURIComponent(videoUrl)}` });
        }

        return res.json({ success: true, formats });
    } catch (error) {
        console.error("IG Extraction error:", error.message);
        return res.status(500).json({ success: false, error: "Extraction Failed. Try again later." });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`NUMU SAVER backend running on port ${port}`);
});
