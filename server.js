require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { Pool } = require('pg');

const app = express();

// Environment variables
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
};

// ===== Database Connection =====
const pool = new Pool(dbConfig);

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err);
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});
// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// HTTP logging
if (NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Routes =====
// Health check endpoint for container orchestration
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Readiness probe
app.get('/ready', (req, res) => {
  res.status(200).json({ ready: true });
});

// Main endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Hello World!', environment: NODE_ENV });
});

// ===== Test DB Create API =====
// Creates a test table (if missing) and inserts a row.
app.post('/create-test', async (req, res) => {
  const name = req.body.name || `item-${Date.now()}`;

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS test_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    const insertResult = await pool.query(
      'INSERT INTO test_items (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );

    res.status(201).json({
      success: true,
      message: 'Inserted test record',
      item: insertResult.rows[0]
    });
  } catch (err) {
    console.error('Create test record error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create test record',
      error: err.message
    });
  }
});

// Fetch test records
app.get('/test-items', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, created_at FROM test_items ORDER BY id DESC LIMIT 50');
    res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error('Fetch test items error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch test items', error: err.message });
  }
});

// ===== Error Handling =====
// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: 'The requested resource was not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  const status = err.status || 500;
  const message = NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
  res.status(status).json({ error: message, requestId: req.id });
});

// ===== Server Initialization =====
let server;

function startServer() {
  try {
    server = app.listen(PORT, HOST, () => {
      console.log(`Server running on http://${HOST}:${PORT} in ${NODE_ENV} mode`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// ===== Graceful Shutdown =====
function gracefulShutdown() {
  console.log('Received shutdown signal, closing server gracefully...');

  if (server) {
    server.close(() => {
      console.log('Server closed');
      // Close database pool
      pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
      });
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      pool.end(() => {});
      process.exit(1);
    }, 10000);
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();