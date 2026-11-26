'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/**
 * Persistent Warm Python Worker Bridge for InsightFace (SCRFD-10G + ArcFace-R50 512-D).
 * Keeps ONNX sessions loaded in RAM so face detection + 5-point alignment + 512-D embedding
 * completes in ~80-150ms per photo without process startup overhead.
 */

class ArcFaceService {
  constructor(rootDir) {
    this.rootDir = rootDir || path.resolve(__dirname, '..');
    this.workerScript = path.join(this.rootDir, 'scripts', 'arcface_worker.py');
    this.detModelPath = path.join(this.rootDir, 'models', 'buffalo_l', 'det_10g.onnx');
    this.recModelPath = path.join(this.rootDir, 'models', 'buffalo_l', 'w600k_r50.onnx');

    this.proc = null;
    this.readyPromise = null;
    this.isReady = false;
    this.reqCounter = 0;
    this.pending = new Map();
    this.disposed = false;
  }

  hasModelsOnDisk() {
    return (
      fs.existsSync(this.workerScript) &&
      fs.existsSync(this.detModelPath) &&
      fs.existsSync(this.recModelPath)
    );
  }

  ensureStarted() {
    if (this.disposed) {
      return Promise.reject(new Error('ArcFaceService has been shut down'));
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    if (!this.hasModelsOnDisk()) {
      return Promise.reject(new Error('ไม่พบไฟล์โมเดล InsightFace (det_10g.onnx / w600k_r50.onnx)'));
    }

    this.readyPromise = new Promise((resolve, reject) => {
      const pythonCmd = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      const child = spawn(pythonCmd, ['-u', this.workerScript], {
        cwd: this.rootDir,
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

      child.stderr.on('data', (chunk) => {
        const errStr = chunk.toString('utf8').trim();
        if (!startupSettled && errStr) {
          // keep watching in case fatal exit follows
        }
      });

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

  async analyzeImage({ imagePath, imageBase64, saveThumbPath, scoreThresh = 0.45, flipAugment = true }) {
    return this.sendCommand(
      {
        cmd: 'analyze',
        imagePath,
        imageBase64,
        saveThumbPath,
        scoreThresh,
        flipAugment
      },
      30000
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

module.exports = { ArcFaceService };
