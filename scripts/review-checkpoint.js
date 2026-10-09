#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function atomicWrite(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, filePath); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

function defaultCheckpointPath(taskId) {
  return path.join(os.tmpdir(), 'apes-checkpoints', `${taskId}.json`);
}

function stableTaskId(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

class ReviewCheckpoint {
  constructor({ taskId, checkpointPath, chunkCount, headSha, reviewTarget, planHash = null }) {
    if (!taskId || !/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new Error('Invalid checkpoint task id.');
    this.taskId = taskId;
    this.path = checkpointPath || defaultCheckpointPath(taskId);
    this.chunkCount = Number(chunkCount);
    if (!Number.isSafeInteger(this.chunkCount) || this.chunkCount < 1) throw new Error('Invalid checkpoint chunk count.');
    if (planHash !== null && !/^[0-9a-f]{64}$/.test(planHash)) throw new Error('Invalid checkpoint plan hash.');
    this.planHash = planHash;
    this.headSha = headSha || null;
    this.reviewTarget = reviewTarget || null;
    this.state = {
      schemaVersion: 2,
      planHash: this.planHash,
      taskId,
      chunkCount: this.chunkCount,
      headSha: this.headSha,
      reviewTarget: this.reviewTarget,
      completedChunks: {},
      updatedAt: null,
    };
  }

  load() {
    if (!fs.existsSync(this.path)) return this;
    try {
    const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    if (parsed.schemaVersion !== 2) throw new Error('Unsupported checkpoint schema version.');
    if (parsed.taskId !== this.taskId || parsed.chunkCount !== this.chunkCount || parsed.headSha !== this.headSha || parsed.reviewTarget !== this.reviewTarget || parsed.planHash !== this.planHash) {
      throw new Error('Checkpoint identity mismatch; refusing to resume a different review task.');
    }
    if (!parsed.completedChunks || typeof parsed.completedChunks !== 'object' || Array.isArray(parsed.completedChunks)) {
      throw new Error('Checkpoint completedChunks state is invalid.');
    }
    const indices = Object.keys(parsed.completedChunks);
    for (const key of indices) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= this.chunkCount) throw new Error('Checkpoint chunk index out of range.');
      const entry = parsed.completedChunks[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.chunkIndex !== Number(key) || !Array.isArray(entry.findings) || !Array.isArray(entry.providers) || typeof entry.committedAt !== 'string') throw new Error('Checkpoint chunk entry is malformed.');
      if (entry.findings.some(f => !f || typeof f !== 'object' || Array.isArray(f) || typeof f.path !== 'string' || !Number.isSafeInteger(f.line) || f.line < 1 || !['P0','P1','P2','P3'].includes(f.severity) || typeof f.comment !== 'string' || !['LEFT','RIGHT'].includes(f.side || 'RIGHT'))) throw new Error('Checkpoint findings are malformed.');
      if (entry.providers.some(p => typeof p !== 'string' || !p.trim())) throw new Error('Checkpoint providers are malformed.');
    }
    this.state = parsed;
    this.restored = true;
    return this;
    } catch (_) {
      // Never replay corrupt or wrong-plan state. Remove it from the active path.
      const quarantinePath = `${this.path}.invalid.${process.pid}.${Date.now()}`;
      fs.renameSync(this.path, quarantinePath);
      this.restored = false;
      this.invalidCheckpointQuarantined = true;
      console.warn('APES_CHECKPOINT_INVALID: checkpoint quarantined; restarting uncommitted review from chunk zero.');
      return this;
    }
  }

  isComplete(index) {
    return !!this.state.completedChunks[String(index)];
  }

  completed(index) {
    return this.state.completedChunks[String(index)] || null;
  }

  commit(index, result) {
    const key = String(index);
    if (this.isComplete(index)) return this.completed(index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) throw new Error('Checkpoint chunk index out of range.');
    if (!result || typeof result !== 'object') throw new Error('Checkpoint result must be an object.');
    if (!Array.isArray(result.findings) || !Array.isArray(result.providers)) throw new Error('Checkpoint result arrays are required.');
    const entry = {
      chunkIndex: index,
      findings: Array.isArray(result.findings) ? result.findings : [],
      providers: Array.isArray(result.providers) ? result.providers : [],
      committedAt: new Date().toISOString(),
    };
    const nextState = { ...this.state, completedChunks: { ...this.state.completedChunks, [key]: entry }, updatedAt: entry.committedAt };
    atomicWrite(this.path, JSON.stringify(nextState, null, 2));
    this.state = nextState;
    return entry;
  }

  completedEntries() {
    return Object.values(this.state.completedChunks).sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  isFullyComplete() {
    return Array.from({ length: this.chunkCount }, (_, i) => this.isComplete(i)).every(Boolean);
  }
}

module.exports = { ReviewCheckpoint, stableTaskId, defaultCheckpointPath, atomicWrite };
