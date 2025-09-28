const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

const API_URL = 'https://raw.githubusercontent.com/jitendra-unatti/fancode/main/data/fancode.json';

const CACHE_TTL = 30000; // 30 seconds
const VALIDATION_TIMEOUT = 10000;

let cachedData = null;
let cacheTimestamp = null;
const streamBaseUrls = new Map(); // match_id => base stream URL

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve HTML and static files from 'public' folder

// Serve main.html and player.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Fetch matches
app.get('/api/matches', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedData && cacheTimestamp && (now - cacheTimestamp) < CACHE_TTL) {
      return res.json(cachedData);
    }

    const data = await fetchJson(API_URL);

    const processedMatches = (data.matches || []).map(match => ({
      ...match,
      teams: match.teams || [],
      streams: {
        adfree_stream: match.adfree_stream,
        dai_stream: match.dai_stream,
        Primary_Playback_URL: match.STREAMING_CDN?.Primary_Playback_URL,
        fancode_cdn: match.STREAMING_CDN?.fancode_cdn,
        dai_google_cdn: match.STREAMING_CDN?.dai_google_cdn,
        cloudfront_cdn: match.STREAMING_CDN?.cloudfront_cdn,
        sony_cdn: match.STREAMING_CDN?.sony_cdn,
        hindi_stream: match.STREAMING_CDN?.hindi_stream,
      }
    }));

    const liveMatches = processedMatches.filter(m => m.status === 'LIVE');
    const upcomingMatches = processedMatches.filter(m => m.status === 'NOT_STARTED');

    cachedData = {
      ...data,
      matches: processedMatches,
      categories: [...new Set(processedMatches.map(m => m.category))],
      live_matches: liveMatches.length,
      upcoming_matches: upcomingMatches.length,
      total_matches: processedMatches.length,
    };
    cacheTimestamp = now;

    res.json(cachedData);
  } catch (err) {
    console.error('API Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch matches: ' + err.message });
  }
});

// Fetch specific match
app.get('/api/matches/:matchId', async (req, res) => {
  const { matchId } = req.params;
  try {
    const now = Date.now();
    if (!cachedData || !cacheTimestamp || (now - cacheTimestamp) >= CACHE_TTL) {
      const data = await fetchJson(API_URL);

      const processedMatches = (data.matches || []).map(match => ({
        ...match,
        teams: match.teams || [],
        streams: {
          adfree_stream: match.adfree_stream,
          dai_stream: match.dai_stream,
          Primary_Playback_URL: match.STREAMING_CDN?.Primary_Playback_URL,
          fancode_cdn: match.STREAMING_CDN?.fancode_cdn,
          dai_google_cdn: match.STREAMING_CDN?.dai_google_cdn,
          cloudfront_cdn: match.STREAMING_CDN?.cloudfront_cdn,
          sony_cdn: match.STREAMING_CDN?.sony_cdn,
          hindi_stream: match.STREAMING_CDN?.hindi_stream,
        }
      }));

      cachedData = {
        ...data,
        matches: processedMatches,
        categories: [...new Set(processedMatches.map(m => m.category))],
        live_matches: processedMatches.filter(m => m.status === 'LIVE').length,
        upcoming_matches: processedMatches.filter(m => m.status === 'NOT_STARTED').length,
        total_matches: processedMatches.length
      };

      cacheTimestamp = now;
    }

    const match = cachedData.matches.find(m => m.match_id == matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json(match);
  } catch (err) {
    console.error('Match Fetch Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch match: ' + err.message });
  }
});

// 1️⃣ Route for master playlist
app.get('/api/stream/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const cdnType = req.query.cdn || 'adfree_stream';

  try {
    const match = cachedData?.matches.find(m => m.match_id == matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const streamUrl = match.streams[cdnType];
    if (!streamUrl || !streamUrl.includes('.m3u8')) {
      return res.status(404).json({ error: 'Invalid or missing stream URL' });
    }

    console.log(`Validating and rewriting master playlist for matchId=${matchId}, cdn=${cdnType}`);

    https.get(streamUrl, {
      timeout: VALIDATION_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, streamRes => {
      if (streamRes.statusCode >= 200 && streamRes.statusCode < 300) {
        let rawData = '';
        streamRes.on('data', chunk => rawData += chunk);
        streamRes.on('end', () => {
          const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
          streamBaseUrls.set(matchId, baseUrl);

          let playlist = rawData
            .replace(/(\S+\.m3u8)/g, `/api/stream/${matchId}/$1`)
            .replace(/(\S+\.ts)/g, `/api/stream/${matchId}/$1`);

          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.send(playlist);
        });
      } else {
        console.error(`Failed to fetch master playlist. Status: ${streamRes.statusCode}`);
        res.status(404).json({ error: 'Stream URL not accessible' });
      }
    }).on('error', (e) => {
      console.error('Stream request error:', e.message);
      res.status(500).json({ error: 'Failed to fetch stream: ' + e.message });
    });

  } catch (err) {
    console.error('Stream Error:', err.message);
    res.status(500).json({ error: 'Stream proxy failed: ' + err.message });
  }
});


// 2️⃣ Route for proxying segments (e.g., .ts, .m3u8 child playlists)
app.get('/api/stream/:matchId/:segment', async (req, res) => {
  const { matchId, segment } = req.params;

  try {
    const baseUrl = streamBaseUrls.get(matchId);
    if (!baseUrl) {
      return res.status(404).json({ error: 'Stream base URL not found' });
    }

    const segmentUrl = `${baseUrl}${segment}`;
    console.log(`Proxying segment: ${segmentUrl}`);

    https.get(segmentUrl, {
      timeout: VALIDATION_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, streamRes => {
      if (streamRes.statusCode >= 200 && streamRes.statusCode < 300) {
        res.setHeader('Content-Type', streamRes.headers['content-type'] || 'application/octet-stream');
        streamRes.pipe(res);
      } else {
        console.error(`Failed to fetch segment: ${segmentUrl}, Status: ${streamRes.statusCode}`);
        res.status(streamRes.statusCode).json({ error: 'Failed to fetch segment' });
      }
    }).on('error', (e) => {
      console.error('Segment fetch error:', e.message);
      res.status(500).json({ error: 'Failed to fetch segment: ' + e.message });
    });

  } catch (err) {
    console.error('Segment Error:', err.message);
    res.status(500).json({ error: 'Stream segment proxy failed: ' + err.message });
  }
});


// Helper to proxy stream segments
function proxyStream(segmentUrl, res) {
  https.get(segmentUrl, {
    timeout: VALIDATION_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }, streamRes => {
    if (streamRes.statusCode >= 200 && streamRes.statusCode < 300) {
      res.setHeader('Content-Type', streamRes.headers['content-type'] || 'application/octet-stream');
      streamRes.pipe(res);
    } else {
      res.status(streamRes.statusCode).json({ error: 'Failed to fetch segment' });
    }
  }).on('error', (e) => {
    console.error(`Proxy stream error: ${segmentUrl}`, e.message);
    res.status(500).json({ error: 'Proxy stream failed: ' + e.message });
  });
}

// Helper to fetch JSON with HTTPS
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 5000 }, res => {
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (err) {
          reject(new Error('Invalid JSON: ' + err.message));
        }
      });
    }).on('error', (err) => {
      reject(new Error('Network error: ' + err.message));
    }).on('timeout', () => {
      reject(new Error('Request timed out'));
    });
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`✅ Express server running on http://localhost:${PORT}`);
});
