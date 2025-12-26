const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_NAME = process.env.DB_NAME || 'hirishi-mirror';

// Resolve MongoDB URI from env or a local .env file without extra deps.
function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.includes('=')) {
        const [key, ...rest] = line.split('=');
        if (key.trim() === 'MONGODB_URI') return rest.join('=').trim();
      }
      // Fallback: if someone pasted the URI without a key, accept it.
      if (line.startsWith('mongodb')) return line;
    }
  }

  return 'mongodb://localhost:27017/simple-web-project';
}

const MONGODB_URI = resolveMongoUri();
let collection;

// Basic cookie parser so we can track a per-browser userId without extra deps.
function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = rest.join('=');
    return acc;
  }, {});
}

function generateUserId() {
  // Short, URL-safe id (8 chars) instead of a full UUID.
  return randomBytes(6).toString('base64url');
}

function setUserIdCookie(res, userId) {
  // Express has res.cookie; fallback to manual Set-Cookie if unavailable.
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 365, // ~1 year
  };
  if (typeof res.cookie === 'function') {
    res.cookie('userId', userId, opts);
  } else {
    const parts = [`userId=${userId}`, 'Path=/', 'SameSite=Lax', 'Max-Age=' + opts.maxAge / 1000, 'HttpOnly'];
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  const db = client.db(DB_NAME);
  collection = db.collection('entries');
  await collection.createIndex({ createdAt: 1 });
  console.log('Connected to MongoDB');
}

app.use(express.json());

// Assign a stable userId cookie on first visit so we can tell which browser sent each entry.
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let userId = cookies.userId;

  if (!userId) {
    userId = generateUserId();
    setUserIdCookie(res, userId);
  }

  req.userId = userId;
  next();
});

// Serve the frontend from ../public so the client can call the API from the same origin.
app.use(express.static(path.join(__dirname, '..', 'public')));

// POST /add: write path. Accepts text from the client, stamps it with createdAt, persists to MongoDB.
app.post('/add', async (req, res) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(400).json({ error: 'Text is required.' });
    }

    const entry = { text, createdAt: new Date(), userId: req.userId };
    const result = await collection.insertOne(entry);

    res.status(201).json({ id: result.insertedId, ...entry });
  } catch (err) {
    console.error('POST /add failed', err);
    res.status(500).json({ error: 'Failed to save entry.' });
  }
});

// GET /all: read path. Returns all entries in chronological order so the UI can render them.
app.get('/all', async (req, res) => {
  try {
    const entries = await collection
      .find({}, { projection: { text: 1, createdAt: 1, userId: 1 } })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(entries);
  } catch (err) {
    console.error('GET /all failed', err);
    res.status(500).json({ error: 'Failed to fetch entries.' });
  }
});

// Expose the current userId so the frontend can display who "you" are.
app.get('/whoami', (req, res) => {
  res.json({ userId: req.userId });
});

// Start the HTTP server only after MongoDB is ready so requests never run without persistence.
connectToDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  });
