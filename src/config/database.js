const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test connection
pool.query('SELECT NOW()').then(() => {
  console.log('✅ Database connected');
}).catch(err => {
  console.error('❌ Database connection error:', err);
});

module.exports = pool;