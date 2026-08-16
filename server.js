require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { ApifyClient } = require("apify-client");

const app = express();

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"]
  })
);

app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "NUMU SAVER backend is running"
  });
});

// Instagram URL validation
function isValidInstagramUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    return (
      hostname === "instagram.com" ||
      hostname === "www.instagram.com" ||
      hostname.endsWith(".instagram.com")
    );
  } catch {
    return false;
  }
}

// Instagram extraction
app.post("/api/instagram/extract", async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url || !isValidInstagramUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Instagram URL provided."
      });
    }

    const token = process.env.APIFY_API_TOKEN;

    if (!token) {
      console.error("APIFY_API_TOKEN is missing.");
      return res.status(500).json({
        success: false,
        error: "Backend configuration error."
      });
    }

    console.log("Starting extraction for:", url);

    const client = new ApifyClient({
      token
    });

    const run = await client
      .actor("apify/instagram-scraper")
      .call({
        directUrls: [url],
        resultsType: "details"
      });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems();

    if (!items || items.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Media is unavailable or private."
      });
    }

    const media = items[0];

    const videoUrl =
      media.videoUrl ||
      media.video_url ||
      media.video?.url ||
      null;

    if (!videoUrl) {
      return res.status(404).json({
        success: false,
        error: "No video found. Make sure this is a public Instagram video or Reel."
      });
    }

    return res.status(200).json({
      success: true,
      formats: [
        {
          quality: "Original HD",
          url: videoUrl
        }
      ]
    });
  } catch (error) {
    console.error("Extraction error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to extract this public Instagram media. Please try again later."
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`NUMU SAVER backend running on port ${PORT}`);
});
