'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

class StreamedWasmPool {
  constructor(opts = {}) {
    const defaultPoolSize = Math.max(1, Math.min(4, Number(process.env.STREAMED_WORKER_POOL_SIZE || 2)));
    this.poolSize = opts.poolSize || defaultPoolSize;
    this.workers = [];
    this.jobQueue = [];
    this.pendingResolvers = new Map();
    this.jobCounter = 0;
    this.isDestroyed = false;
    this._workerFactory = opts.workerFactory || ((scriptPath) => new Worker(scriptPath));

    this._workerScriptPath = this._resolveWorkerScriptPath();
    this._initPool();
  }

  _resolveWorkerScriptPath() {
    const candidates = [
      path.join(__dirname, '..', 'providers', 'streamed_wasm_worker.js'),
      path.join(__dirname, 'streamed_wasm_worker.js'),
      path.join(process.cwd(), 'src', 'providers', 'streamed_wasm_worker.js'),
      path.join(process.cwd(), 'dist', 'streamed_wasm_worker.js')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  _initPool() {
    for (let i = 0; i < this.poolSize; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(index) {
    if (this.isDestroyed) return;

    try {
      const worker = this._workerFactory(this._workerScriptPath);
      const workerObj = {
        id: index,
        worker,
        ready: false,
        busy: false,
        currentJobId: null
      };

      worker.on('message', (msg) => {
        if (!msg) return;

        if (msg.type === 'ready') {
          workerObj.ready = true;
          this._drainQueue();
          return;
        }

        if (msg.jobId) {
          // Ignore late responses from jobs that have already timed out or been superseded.
          if (workerObj.currentJobId !== msg.jobId) return;

          const resolver = this.pendingResolvers.get(msg.jobId);
          if (resolver) {
            this.pendingResolvers.delete(msg.jobId);
            clearTimeout(resolver.timer);
            resolver.resolve(msg.error ? null : (msg.m3u8Url || null));
          }

          workerObj.busy = false;
          workerObj.currentJobId = null;
          this._drainQueue();
        }
      });

      worker.on('error', (err) => {
        console.error(`[StreamedWasmPool] Worker #${index} encountered error:`, err.message);
        if (workerObj.currentJobId) {
          const resolver = this.pendingResolvers.get(workerObj.currentJobId);
          if (resolver) {
            this.pendingResolvers.delete(workerObj.currentJobId);
            clearTimeout(resolver.timer);
            resolver.resolve(null);
          }
        }
      });

      worker.on('exit', (code) => {
        const idx = this.workers.indexOf(workerObj);
        if (idx !== -1) {
          this.workers.splice(idx, 1);
        }

        if (!this.isDestroyed) {
          console.warn(`[StreamedWasmPool] Worker #${index} exited with code ${code}. Respawning...`);
          this._spawnWorker(index);
        }
      });

      this.workers.push(workerObj);
    } catch (err) {
      console.error(`[StreamedWasmPool] Failed to spawn worker #${index}:`, err.message);
    }
  }

  _drainQueue() {
    while (this.jobQueue.length > 0) {
      const idleWorker = this.workers.find(w => w.ready && !w.busy);
      if (!idleWorker) return;

      const job = this.jobQueue.shift();
      if (!job) return;

      // A queued job may have timed out before a worker became available.
      if (!this.pendingResolvers.has(job.jobId)) continue;

      idleWorker.busy = true;
      idleWorker.currentJobId = job.jobId;
      idleWorker.worker.postMessage({
        jobId: job.jobId,
        user: job.user,
        event: job.event,
        id: job.id,
        embedUrl: job.embedUrl
      });
    }
  }

  async resolveWasmStream(user, event, id, embedUrl, timeoutMs = 12000) {
    if (typeof user === 'string' && (user.startsWith('http://') || user.startsWith('https://'))) {
      embedUrl = user;
      const match = embedUrl.match(/\/embed\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/i);
      if (match) {
        user = match[1];
        event = match[2];
        id = match[3];
      }
    }
    if (this.isDestroyed || this.workers.length === 0) {
      return null;
    }

    const jobId = `job_${++this.jobCounter}_${Date.now()}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const resolver = this.pendingResolvers.get(jobId);
        if (!resolver) return;

        this.pendingResolvers.delete(jobId);
        const queuedIndex = this.jobQueue.findIndex(job => job.jobId === jobId);
        if (queuedIndex !== -1) {
          this.jobQueue.splice(queuedIndex, 1);
        }

        const activeWorker = this.workers.find(work => work.currentJobId === jobId);
        if (activeWorker) {
          // Do not mark a still-running worker idle: terminate it so its state cannot
          // overlap with the next job. The exit handler replaces it and resumes the queue.
          activeWorker.ready = false;
          Promise.resolve(activeWorker.worker.terminate()).catch(() => {});
        } else {
          this._drainQueue();
        }

        resolve(null);
      }, timeoutMs);

      this.pendingResolvers.set(jobId, { resolve, timer });

      const idleWorker = this.workers.find(w => w.ready && !w.busy);
      if (idleWorker) {
        idleWorker.busy = true;
        idleWorker.currentJobId = jobId;
        idleWorker.worker.postMessage({ jobId, user, event, id, embedUrl });
      } else {
        this.jobQueue.push({ jobId, user, event, id, embedUrl });
      }
    });
  }

  async destroy() {
    this.isDestroyed = true;
    for (const item of this.pendingResolvers.values()) {
      clearTimeout(item.timer);
      item.resolve(null);
    }
    this.pendingResolvers.clear();
    this.jobQueue = [];

    const terminations = this.workers.map(w =>
      Promise.resolve(w.worker.terminate()).catch(() => {})
    );
    await Promise.allSettled(terminations);
    this.workers = [];
  }
}

// Export singleton instance as well as class
const defaultInstance = new StreamedWasmPool();
defaultInstance.StreamedWasmPool = StreamedWasmPool;

module.exports = defaultInstance;
