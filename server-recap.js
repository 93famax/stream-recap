const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Middleware pour capturer le body brut (pour validation EventSub)
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => data += chunk);
  req.on('end', () => {
    req.rawBody = data;
    req.body = data ? JSON.parse(data) : {};
    next();
  });
});

app.use(cors());

// Configuration Twitch API
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
const TWITCH_EXT_SECRET = process.env.TWITCH_EXTENSION_SECRET;

// Dossiers de stockage
const VIDEOS_DIR = path.join(__dirname, 'videos');
const CLIPS_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'temp');

// Créer les dossiers
[VIDEOS_DIR, CLIPS_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Créé dossier: ${dir}`);
  }
});

// Stockage en mémoire
const streams = new Map();
const clips = new Map();
const generatingVideos = new Map(); // Pour éviter les générations en double

const twitchHeaders = {
  'Client-ID': TWITCH_CLIENT_ID,
  'Authorization': `Bearer ${TWITCH_ACCESS_TOKEN}`
};

// ====== VALIDATION EVENTSUB ======

function validateEventSubSignature(req, res, next) {
  if (!TWITCH_EXT_SECRET) {
    console.warn('⚠️  Secret EventSub non configuré');
    return next();
  }

  const messageId = req.headers['twitch-eventsub-message-id'];
  const messageTimestamp = req.headers['twitch-eventsub-message-timestamp'];
  const messageSignature = req.headers['twitch-eventsub-message-signature'];
  const body = req.rawBody;

  if (!messageId || !messageTimestamp || !messageSignature) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const messageTime = Math.floor(new Date(messageTimestamp).getTime() / 1000);
  if (Math.abs(currentTime - messageTime) > 600) {
    return res.status(403).json({ error: 'Timestamp too old' });
  }

  const hmacMessage = messageId + messageTimestamp + body;
  const computedSignature = 'sha256=' + crypto
    .createHmac('sha256', TWITCH_EXT_SECRET)
    .update(hmacMessage)
    .digest('hex');

  try {
    crypto.timingSafeEqual(
      Buffer.from(messageSignature),
      Buffer.from(computedSignature)
    );
  } catch (e) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  next();
}

app.post('/webhooks/twitch/category-change', validateEventSubSignature, (req, res) => {
  const body = req.body;

  // Répondre au challenge
  if (body.subscription?.status === 'webhook_callback_verification') {
    console.log('🔐 Challenge reçu');
    return res.status(200).send(body.challenge);
  }

  const channelId = body.event?.broadcaster_user_id;
  const newCategory = body.event?.category_name;
  const oldCategory = body.event?.category_name_old;

  console.log(`📡 Catégorie changée: ${oldCategory} → ${newCategory}`);

  // Créer un clip pour l'ancien segment
  if (streams.has(channelId)) {
    const now = Date.now();
    createClip(channelId, {
      category: oldCategory || 'Stream',
      title: `${oldCategory || 'Segment'}`,
      startTime: streams.get(channelId).lastSegmentStart,
      endTime: now
    });

    // Update le start du nouveau segment
    streams.get(channelId).lastSegmentStart = now;
    streams.get(channelId).currentCategory = newCategory;
  }

  res.json({ success: true });
});

// ====== ROUTES STREAM ======

app.post('/api/stream/:channelId/start', (req, res) => {
  const { channelId } = req.params;
  const now = Date.now();

  streams.set(channelId, {
    startTime: new Date(now),
    currentCategory: 'Stream',
    lastSegmentStart: now,
    clips: []
  });

  console.log(`▶️  Stream démarré: ${channelId}`);
  res.json({ success: true, startTime: new Date(now) });
});

app.post('/api/stream/:channelId/end', (req, res) => {
  const { channelId } = req.params;
  const stream = streams.get(channelId);

  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  stream.endTime = new Date();
  console.log(`⏹️  Stream terminé: ${channelId}`);
  res.json({ success: true });
});

app.get('/api/stream/:channelId/info', (req, res) => {
  const { channelId } = req.params;
  const stream = streams.get(channelId);

  if (!stream) {
    return res.status(404).json({ error: 'Stream not found' });
  }

  res.json({
    channelId,
    startTime: stream.startTime,
    currentCategory: stream.currentCategory,
    clipsCount: stream.clips.length
  });
});

// ====== ROUTES CLIPS ======

function createClip(channelId, clipData) {
  try {
    if (!clips.has(channelId)) {
      clips.set(channelId, []);
    }

    const clip = {
      id: crypto.randomUUID(),
      ...clipData,
      createdAt: new Date(),
      processed: false // Pas encore généré en vidéo
    };

    clips.get(channelId).push(clip);
    console.log(`🎬 Clip créé: ${clip.title} (${channelId})`);

    return clip;
  } catch (error) {
    console.error('Error creating clip:', error);
  }
}

app.post('/api/stream/:channelId/clip', (req, res) => {
  const { channelId } = req.params;
  const { category, title, startTime, endTime } = req.body;

  const clip = createClip(channelId, {
    category,
    title,
    startTime: new Date(startTime),
    endTime: new Date(endTime)
  });

  if (streams.has(channelId)) {
    streams.get(channelId).clips.push(clip);
  }

  res.json({ success: true, clip });
});

app.get('/api/stream/:channelId/clips', (req, res) => {
  const { channelId } = req.params;
  const streamClips = clips.get(channelId) || [];
  res.json(streamClips);
});

// ====== GÉNÉRATION VIDEO DYNAMIQUE (LE CŒUR DU SYSTÈME) ======

/**
 * Génère une vidéo compilée max 1min avec les meilleurs moments
 * Coupe les clips automatiquement pour tenir dans le temps
 */
async function generateRecapVideo(channelId, minutesLate) {
  try {
    const videoId = `${channelId}_${minutesLate}min_${Date.now()}`;
    const videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

    // Si vidéo existe déjà, la retourner
    if (fs.existsSync(videoPath)) {
      console.log(`♻️  Vidéo trouvée en cache: ${videoId}`);
      return {
        id: videoId,
        url: `/videos/${videoId}.mp4`,
        cached: true
      };
    }

    // Si déjà en train de générer, attendre
    if (generatingVideos.has(videoId)) {
      console.log(`⏳ Vidéo en cours de génération: ${videoId}`);
      return new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!generatingVideos.has(videoId) && fs.existsSync(videoPath)) {
            clearInterval(checkInterval);
            resolve({
              id: videoId,
              url: `/videos/${videoId}.mp4`,
              cached: false
            });
          }
        }, 1000);
      });
    }

    generatingVideos.set(videoId, true);
    console.log(`🎥 Génération video: ${videoId}`);

    const streamClips = clips.get(channelId) || [];
    if (streamClips.length === 0) {
      generatingVideos.delete(videoId);
      return { error: 'No clips available' };
    }

    // Filtrer les clips selon le temps d'arrivée
    const now = Date.now();
    const cutoffTime = now - (minutesLate * 60000);

    const relevantClips = streamClips
      .filter(clip => clip.startTime.getTime() < cutoffTime)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, 5); // Max 5 clips pour compiler

    if (relevantClips.length === 0) {
      generatingVideos.delete(videoId);
      return { error: 'No relevant clips' };
    }

    // Calculer le temps dispo par clip (max 60 secondes total)
    const totalDurationPerClip = Math.floor(60000 / relevantClips.length); // En ms
    const durationPerClip = Math.floor(totalDurationPerClip / 1000); // En secondes

    console.log(`📊 ${relevantClips.length} clips, ${durationPerClip}s par clip`);

    // Créer le fichier de liste FFmpeg
    const listFile = path.join(TEMP_DIR, `${videoId}_list.txt`);
    let listContent = '';

    // Simuler les clips (en prod, télécharger les vrais clips Twitch)
    for (let i = 0; i < relevantClips.length; i++) {
      const clip = relevantClips[i];
      const clipVideoPath = path.join(CLIPS_DIR, `clip_${clip.id}.mp4`);

      // Créer un clip de test (en prod, récupérer depuis Twitch)
      if (!fs.existsSync(clipVideoPath)) {
        await createTestClipVideo(clipVideoPath, durationPerClip);
      }

      // Ajouter à la liste FFmpeg
      listContent += `file '${clipVideoPath}'\n`;
      listContent += `duration ${durationPerClip}\n`;
    }

    fs.writeFileSync(listFile, listContent);

    // Générer la vidéo avec FFmpeg
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Rapide
        '-crf', '28', // Qualité acceptable
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y',
        videoPath
      ]);

      ffmpeg.on('close', (code) => {
        generatingVideos.delete(videoId);

        // Cleanup temp
        try {
          fs.unlinkSync(listFile);
        } catch (e) {}

        if (code === 0) {
          console.log(`✅ Vidéo générée: ${videoId}`);
          resolve({
            id: videoId,
            url: `/videos/${videoId}.mp4`,
            size: fs.statSync(videoPath).size,
            duration: durationPerClip * relevantClips.length
          });
        } else {
          console.error(`❌ FFmpeg erreur: ${code}`);
          resolve({ error: 'Failed to generate video' });
        }
      });

      ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
      });
    });
  } catch (error) {
    console.error('Error generating video:', error);
    generatingVideos.delete(`${channelId}_${minutesLate}min`);
    return { error: error.message };
  }
}

/**
 * Créer un clip vidéo de test (en prod, ce serait les vrais clips Twitch)
 */
function createTestClipVideo(outputPath, durationSeconds) {
  return new Promise((resolve) => {
    // Créer une vidéo noire simple de la durée
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', `color=c=black:s=1280x720:d=${durationSeconds}`,
      '-f', 'lavfi',
      '-i', `sine=f=1000:d=${durationSeconds}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-y',
      outputPath
    ]);

    ffmpeg.on('close', () => {
      console.log(`✅ Clip de test créé: ${outputPath}`);
      resolve();
    });
  });
}

// Route pour obtenir le récap vidéo
app.get('/api/stream/:channelId/recap', async (req, res) => {
  const { channelId } = req.params;
  const { minutesLate } = req.query;

  if (!minutesLate) {
    return res.status(400).json({ error: 'minutesLate required' });
  }

  try {
    const recap = await generateRecapVideo(channelId, parseInt(minutesLate, 10));
    res.json(recap);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Servir les vidéos générées
app.use('/videos', express.static(VIDEOS_DIR));
app.use('/clips', express.static(CLIPS_DIR));

// ====== CLEANUP AUTOMATIQUE ======

// Supprimer les vidéos de plus de 24h
setInterval(() => {
  try {
    const files = fs.readdirSync(VIDEOS_DIR);
    const now = Date.now();

    files.forEach(file => {
      const filePath = path.join(VIDEOS_DIR, file);
      const stat = fs.statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      const age24h = 24 * 60 * 60 * 1000;

      if (ageMs > age24h) {
        fs.unlinkSync(filePath);
        console.log(`🗑️  Vidéo supprimée: ${file}`);
      }
    });
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60 * 60 * 1000); // Chaque heure

// ====== SANTÉ ======

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    streams: streams.size,
    videosInCache: fs.readdirSync(VIDEOS_DIR).length
  });
});

// ====== ERREURS ======

app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// ====== START ======

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 Stream Recap Backend
========================
Port: ${PORT}
Env: ${process.env.NODE_ENV || 'development'}
Twitch Client ID: ${TWITCH_CLIENT_ID ? '✅' : '❌'}
Videos Dir: ${VIDEOS_DIR}
========================
  `);
});

module.exports = app;
