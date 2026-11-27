'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

/**
 * Persistent Multi-Worker Pool Bridge for InsightFace (SCRFD-10G + ArcFace-R50 512-D).
 * - Spawns 1–3 warm Python ONNX workers (default 2 on >=4-core CPUs) and dispatches to the least-busy worker.
 * - Supports saveThumbPath (720px) + savePreviewPath (1600px) in a single image decode pass.
 */

class SingleArcFaceWorker {
  constructor(rootDir, workerScript, ortThreads) {
    this.rootDir = rootDir;
    this.workerScript = workerScript;
    this.ortThreads = ortThreads;
    this.proc = null;
    this.readyPromise = null;
    this.isReady = false;
    this.reqCounter = 0;
    this.pending = new Map();
    this.disposed = false;
  }

  get inFlight() {
    return this.pending.size;
  }

  ensureStarted() {
    if (this.disposed) {
      return Promise.reject(new Error('ArcFace worker has been shut down'));
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise((resolve, reject) => {
      const pythonCmd = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      const env = { ...process.env };
      if (this.ortThreads > 0 && !env.ORT_THREADS) {
        env.ORT_THREADS = String(this.ortThreads);
      }

      const child = spawn(pythonCmd, ['-u', this.workerScript], {
        cwd: this.rootDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.proc = child;

      let startupSettled = false;
      const rl = readline.createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        if (!startupSettled && msg.ready) {
          startupSettled = true;
          this.isReady = true;
          resolve(true);
          return;
        }

        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resFn, rejFn, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.ok) resFn(msg);
          else rejFn(new Error(msg.error || 'ArcFace worker error'));
        }
      });

      child.stderr.on('data', () => {});

      child.on('exit', (code) => {
        this.isReady = false;
        this.proc = null;
        this.readyPromise = null;
        if (!startupSettled) {
          startupSettled = true;
          reject(new Error(`ArcFace worker exited during startup (code ${code})`));
        }
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.rejFn(new Error('ArcFace worker exited unexpectedly'));
        }
        this.pending.clear();
      });
    });

    return this.readyPromise;
  }

  async sendCommand(payload, timeoutMs = 45000) {
    await this.ensureStarted();
    const id = ++this.reqCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ArcFace worker timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      this.pending.set(id, { resFn: resolve, rejFn: reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }

  shutdown() {
    this.disposed = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.isReady = false;
    this.readyPromise = null;
  }
}

class ArcFaceService {
  constructor(rootDir, opts = {}) {
    this.rootDir = rootDir || path.resolve(__dirname, '..');
    this.workerScript = path.join(this.rootDir, 'scripts', 'arcface_worker.py');
    this.detModelPath = path.join(this.rootDir, 'models', 'buffalo_l', 'det_10g.onnx');
    this.recModelPath = path.join(this.rootDir, 'models', 'buffalo_l', 'w600k_r50.onnx');

    const cpuCount = (os.cpus() || []).length || 2;
    const defaultPool = cpuCount >= 4 ? 2 : 1;
    const rawPool = Number(opts.poolSize || process.env.ARCFACE_WORKERS || defaultPool);
    this.poolSize = Math.max(1, Math.min(4, Number.isFinite(rawPool) ? rawPool : defaultPool));
    const ortThreads = this.poolSize > 1 ? Math.max(2, Math.floor(cpuCount / this.poolSize)) : 0;

    this.workers = Array.from({ length: this.poolSize }, () =>
      new SingleArcFaceWorker(this.rootDir, this.workerScript, ortThreads)
    );
    this.rrIndex = 0;
    this.disposed = false;
  }

  hasModelsOnDisk() {
    return (
      fs.existsSync(this.workerScript) &&
      fs.existsSync(this.detModelPath) &&
      fs.existsSync(this.recModelPath)
    );
  }

  async ensureStarted() {
    if (this.disposed) {
      throw new Error('ArcFaceService has been shut down');
    }
    if (!this.hasModelsOnDisk()) {
      throw new Error('ไม่พบไฟล์โมเดล InsightFace (det_10g.onnx / w600k_r50.onnx)');
    }
    // Start primary worker immediately; warm secondary workers in background
    await this.workers[0].ensureStarted();
    for (let i = 1; i < this.workers.length; i++) {
      this.workers[i].ensureStarted().catch(() => {});
    }
    return true;
  }

  _pickWorker() {
    let best = this.workers[0];
    for (let i = 0; i < this.workers.length; i++) {
      const idx = (this.rrIndex + i) % this.workers.length;
      const w = this.workers[idx];
      if (w.inFlight === 0 && w.isReady) {
        this.rrIndex = (idx + 1) % this.workers.length;
        return w;
      }
      if (w.inFlight < best.inFlight) {
        best = w;
      }
    }
    this.rrIndex = (this.rrIndex + 1) % this.workers.length;
    return best;
  }

  async sendCommand(payload, timeoutMs = 45000) {
    if (!this.hasModelsOnDisk()) {
      throw new Error('ไม่พบไฟล์โมเดล InsightFace (det_10g.onnx / w600k_r50.onnx)');
    }
    const worker = this._pickWorker();
    return worker.sendCommand(payload, timeoutMs);
  }

  async analyzeImage({ imagePath, imageBase64, saveThumbPath, savePreviewPath, scoreThresh = 0.45, flipAugment = true }) {
    return this.sendCommand(
      {
        cmd: 'analyze',
        imagePath,
        imageBase64,
        saveThumbPath,
        savePreviewPath,
        scoreThresh,
        flipAugment
      },
      30000
    );
  }

  async generatePreview({ imagePath, savePreviewPath, saveThumbPath }) {
    return this.sendCommand(
      {
        cmd: 'make_preview',
        imagePath,
        savePreviewPath,
        saveThumbPath
      },
      20000
    );
  }

  async analyzeBatchPaths(items, timeoutMs = 180000) {
    return this.sendCommand(
      {
        cmd: 'batch_paths',
        items
      },
      timeoutMs
    );
  }

  shutdown() {
    this.disposed = true;
    for (const w of this.workers) {
      w.shutdown();
    }
  }
}

module.exports = { ArcFaceService };
