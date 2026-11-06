import { parentPort, workerData } from 'node:worker_threads';
import Database from '../lib/sqlite.js';
import { compactMetrics } from './metrics-retention.js';

let database;
let response;
try {
  // Reuse the existing encryption adapter and external key configuration.
  // No app initialization, schedulers, Docker access or network calls here.
  database = new Database(workerData.databasePath, { fileMustExist: true });
  database.pragma('busy_timeout = 5000');
  response = { result: await compactMetrics(database, workerData.now) };
} catch (error) {
  response = { error: error.message };
} finally {
  database?.close();
}
parentPort.postMessage(response);
