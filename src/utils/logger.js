const winston = require('winston');
const { redactLogInfo } = require('./redact');

// Runs before anything is written, on every entry. See utils/redact.js: a
// logged error used to print its request, access token included.
const redactSecrets = winston.format((info) => redactLogInfo(info));

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    redactSecrets(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

module.exports = { logger } ;