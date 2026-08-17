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

// Link FFmpeg to downloaded binary
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

// Security: Unrestricted CORS
app.use(cors());
app.use(express.json());

// Setup temporary directory
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

// Helper: Force Download File with Mobile Headers
const downloadFile = async (url, destPath) => {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': '*/*',
            'Origin': 'https://www.instagram.com',
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

// FORCE MUXER: Merges video and audio strictly
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

// Recursive Deep Scanner to find all media objects regardless of Instagram's JSON structure
function extractMediaNodes(obj, nodes = []) {
    if (!obj || typeof obj !== 'object') return nodes;

    if (Array.isArray(obj)) {
        for (const item of obj) extractMediaNodes(item, nodes);
        return nodes;
    }

    // Is this object a leaf containing actual media URLs?
    const isMediaNode = obj.videoUrl || obj.video_url || obj.videoVersions || obj.downloadUrl || obj.displayUrl || obj.display_url || obj.imageUrl || obj.profilePicUrlHD || obj.imageVersions2;
    
    if (isMediaNode) {
        nodes.push(obj);
    }

    // Recurse into children (exclude massive user objects to save memory)
    for (const key of Object.keys(obj)) {
        if (key !== 'owner' && key !== 'user' && typeof obj[key] === 'object') {
            extractMediaNodes(obj[key], nodes);
        }
    }

    return nodes;
}

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({ success: true, service: "NUMU SAVER Backend is Awake" });
});

// Serve processed MP4 files
app.get('/downloads/:filename', (req, res) => {
    const filepath = path.join(TEMP_DIR, req.params.filename);
    if (fs.existsSync(filepath)) {
        res.download(filepath, 'NUMU-SAVER-Reel.mp4');
    } else {
        res.status(404).send('Download link expired. Please fetch the video again.');
    }
});

// Proxy route (Handles both File Download and Inline Thumbnail Images)
app.get('/api/proxy', async (req, res) => {
    try {
        const mediaUrl = req.query.url;
        const isInline = req.query.inline === 'true'; // If true, show image directly instead of downloading

        if (!mediaUrl) return res.status(400).send('No URL provided');

        const response = await axios({
            method: 'GET',
            url: mediaUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
                'Referer': 'https://www.instagram.com/'
            }
        });

        const contentType = response.headers['content-type'] || '';
        let ext = '.mp4';
        if (contentType.includes('image') || mediaUrl.includes('.jpg')) {
            ext = '.jpg';
        }

        // 'inline' lets the browser render the preview thumbnail instead of downloading it!
        const dispositionType = isInline ? 'inline' : 'attachment';

        res.setHeader('Content-Disposition', `${dispositionType}; filename="NUMU-SAVER-Media${ext}"`);
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
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
            return res.status(500).json({ success: false, error: "Backend config error: Apify token missing." });
        }

        const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
        const run = await client.actor("apify/instagram-scraper").call({ directUrls: [url] });
        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        if (!items || items.length === 0) {
            return res.status(404).json({ success: false, error: "Media not found. Make sure the account is public." });
        }

        if (items[0] && items[0].error) {
            return res.status(400).json({ success: false, error: items[0].error });
        }

        const parsedItems = [];
        const seenUrls = new Set();
        
        const allMediaNodes = extractMediaNodes(items);

        let globalAudioUrl = null;
        if (items[0]) {
            globalAudioUrl = items[0].audioUrl || items[0].audio_url || 
                            (items[0].audioVersions && items[0].audioVersions.length > 0 ? items[0].audioVersions[0].url : null);
        }

        for (const post of allMediaNodes) {
            let formats = [];
            let displayThumbnail = post.displayUrl || post.display_url || post.imageUrl || post.image_url || post.profilePicUrlHD || post.thumbnail_src || post.thumbnailUrl || "";

            let baseVideoUrl = post.videoUrl || post.video_url || post.downloadUrl || post.download_url;
            let audioUrl = post.audioUrl || post.audio_url || globalAudioUrl; 

            if (post.videoVersions && post.videoVersions.length > 0) {
                const uniqueVids = [];
                const seenWidths = new Set();
                for (const v of post.videoVersions) {
                    if (!seenWidths.has(v.width)) {
                        seenWidths.add(v.width);
                        uniqueVids.push(v);
                    }
                }

                for (const vid of uniqueVids) {
                    let vUrl = vid.url;
                    if (!seenUrls.has(vUrl)) {
                        seenUrls.add(vUrl);
                        let q = vid.width ? `${vid.width}p` : "HD Video";
                        
                        if (audioUrl && vUrl !== audioUrl) {
                            const fileId = crypto.randomUUID();
                            const vTemp = path.join(TEMP_DIR, `v_${fileId}.mp4`);
                            const aTemp = path.join(TEMP_DIR, `a_${fileId}.mp4`);
                            const outPath = path.join(TEMP_DIR, `numu_ig_${fileId}.mp4`);

                            try {
                                await downloadFile(vUrl, vTemp);
                                await downloadFile(audioUrl, aTemp);
                                await muxMediaLocally(vTemp, aTemp, outPath);
                                
                                if (fs.existsSync(vTemp)) fs.unlinkSync(vTemp);
                                if (fs.existsSync(aTemp)) fs.unlinkSync(aTemp);
                                
                                deleteFileAfterDelay(outPath, 60 * 60 * 1000); 
                                formats.push({ quality: `${q} (Video + Audio)`, url: `/downloads/numu_ig_${fileId}.mp4` });
                            } catch (e) {
                                formats.push({ quality: `${q} (Video Only)`, url: `/api/proxy?url=${encodeURIComponent(vUrl)}` });
                            }
                        } else {
                            formats.push({ quality: q, url: `/api/proxy?url=${encodeURIComponent(vUrl)}` });
                        }
                    }
                }
            } else if (baseVideoUrl && !seenUrls.has(baseVideoUrl)) {
                seenUrls.add(baseVideoUrl);
                if (audioUrl && baseVideoUrl !== audioUrl) {
                    const fileId = crypto.randomUUID();
                    const vTemp = path.join(TEMP_DIR, `v_${fileId}.mp4`);
                    const aTemp = path.join(TEMP_DIR, `a_${fileId}.mp4`);
                    const outPath = path.join(TEMP_DIR, `numu_ig_${fileId}.mp4`);
                    try {
                        await downloadFile(baseVideoUrl, vTemp);
                        await downloadFile(audioUrl, aTemp);
                        await muxMediaLocally(vTemp, aTemp, outPath);
                        if (fs.existsSync(vTemp)) fs.unlinkSync(vTemp);
                        if (fs.existsSync(aTemp)) fs.unlinkSync(aTemp);
                        
                        deleteFileAfterDelay(outPath, 60 * 60 * 1000); 
                        formats.push({ quality: "Original HD (Video + Audio)", url: `/downloads/numu_ig_${fileId}.mp4` });
                    } catch (e) {
                        formats.push({ quality: "Original HD", url: `/api/proxy?url=${encodeURIComponent(baseVideoUrl)}` });
                    }
                } else {
                    formats.push({ quality: "Original HD", url: `/api/proxy?url=${encodeURIComponent(baseVideoUrl)}` });
                }
            } else if (displayThumbnail && !seenUrls.has(displayThumbnail)) {
                seenUrls.add(displayThumbnail);
                formats.push({ quality: "HD Image/Photo", url: `/api/proxy?url=${encodeURIComponent(displayThumbnail)}` });
            }

            if (formats.length > 0) {
                if (!displayThumbnail && post.imageVersions2 && post.imageVersions2.candidates) {
                    displayThumbnail = post.imageVersions2.candidates[0].url;
                }
                parsedItems.push({
                    thumbnail: displayThumbnail || "",
                    formats: formats
                });
            }
        }

        if (parsedItems.length === 0) {
            return res.status(404).json({ success: false, error: "No video found. Make sure this is a public Instagram video or Reel." });
        }

        return res.json({ success: true, items: parsedItems });
    } catch (error) {
        console.error("IG Extraction error:", error.message);
        return res.status(500).json({ success: false, error: "Extraction Failed. Try again later." });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`NUMU SAVER backend running on port ${port}`);
});
