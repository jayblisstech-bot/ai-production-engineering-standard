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
  fs.renameSync(tmp, filePath);
}

function defaultCheckpointPath(taskId) {
  return path.join(os.tmpdir(), 'apes-checkpoints', `${taskId}.json`);
}

function stableTaskId(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

class ReviewCheckpoint {
  constructor({ taskId, checkpointPath, chunkCount, headSha, reviewTarget }) {
    if (!taskId || !/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new Error('Invalid checkpoint task id.');
    this.taskId = taskId;
    this.path = checkpointPath || defaultCheckpointPath(taskId);
    this.chunkCount = Number(chunkCount);
    this.headSha = headSha || null;
    this.reviewTarget = reviewTarget || null;
    this.state = {
      schemaVersion: 1,
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
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.path, 'utf8')); }
    catch (err) { throw new Error(`Checkpoint exists but is unreadable: ${err.message}`); }
    if (parsed.schemaVersion !== 1) throw new Error('Unsupported checkpoint schema version.');
    if (parsed.taskId !== this.taskId || parsed.chunkCount !== this.chunkCount || parsed.headSha !== this.headSha || parsed.reviewTarget !== this.reviewTarget) {
      throw new Error('Checkpoint identity mismatch; refusing to resume a different review task.');
    }
    if (!parsed.completedChunks || typeof parsed.completedChunks !== 'object' || Array.isArray(parsed.completedChunks)) {
      throw new Error('Checkpoint completedChunks state is invalid.');
    }
    this.state = parsed;
    return this;
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
    if (!result || typeof result !== 'object') throw new Error('Checkpoint result must be an object.');
    const entry = {
      chunkIndex: index,
      findings: Array.isArray(result.findings) ? result.findings : [],
      providers: Array.isArray(result.providers) ? result.providers : [],
      committedAt: new Date().toISOString(),
    };
    this.state.completedChunks[key] = entry;
    this.state.updatedAt = entry.committedAt;
    atomicWrite(this.path, JSON.stringify(this.state, null, 2));
    return entry;
  }

  completedEntries() {
    return Object.values(this.state.completedChunks).sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  isFullyComplete() {
    return Object.keys(this.state.completedChunks).length === this.chunkCount;
  }
}

module.exports = { ReviewCheckpoint, stableTaskId, defaultCheckpointPath, atomicWrite };
