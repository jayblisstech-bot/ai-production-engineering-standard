#!/usr/bin/env node
'use strict';
/**
 * Isolated MOCK-GATEWAY durable ledger implementation for Node 24+.
 * SQLite WAL + BEGIN IMMEDIATE serializes cross-process budget reservations.
 * NOT a certified provider-spend gateway; no provider API or credential egress.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assertBinding, bindingKey, parseCapUsd } = require('../scripts/review-dollar-budget');

const GRANT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function ident(value, name) {
  if (typeof value !== 'string' || !GRANT_RE.test(value)) {
    throw new Error('APES_BUDGET_INVALID_' + name.toUpperCase());
  }
  return value;
}
function micros(amount, name, allowZero = false) {
  if (!Number.isSafeInteger(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    throw new Error('APES_BUDGET_INVALID_' + name.toUpperCase());
  }
  return amount;
}
class SqliteBudgetStore {
  constructor(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename === ':memory:') {
      throw new Error('APES_BUDGET_INVALID_DATABASE_PATH');
    }
    if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || !fs.lstatSync(filename).isFile())) {
      throw new Error('APES_BUDGET_UNSAFE_DATABASE_PATH');
    }
    this.db = new DatabaseSync(filename);
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS budget_grants (',
      'grant_id TEXT PRIMARY KEY, binding_key TEXT NOT NULL,',
      'limit_micros INTEGER NOT NULL CHECK (limit_micros > 0),',
      'used_micros INTEGER NOT NULL DEFAULT 0 CHECK (used_micros >= 0),',
      'reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),',
      "state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','closed')),",
      'CHECK (used_micros + reserved_micros <= limit_micros));',
      'CREATE TABLE IF NOT EXISTS approval_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS budget_requests (',
      'grant_id TEXT NOT NULL, request_id TEXT NOT NULL,',
      'ceiling_micros INTEGER NOT NULL CHECK (ceiling_micros > 0),',
      'charged_micros INTEGER,',
      "status TEXT NOT NULL CHECK (status IN ('reserved','settled')),",
      'PRIMARY KEY (grant_id, request_id),',
      'FOREIGN KEY (grant_id) REFERENCES budget_grants(grant_id) ON DELETE RESTRICT);',
    ].join(' '));
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  authorize(grantId, binding) {
    const row = this.db.prepare('SELECT * FROM budget_grants WHERE grant_id=?').get(ident(grantId, 'grant_id'));
    if (!row || row.binding_key !== bindingKey(assertBinding(binding))) {
      throw new Error('APES_BUDGET_UNAUTHORIZED_GRANT');
    }
    return row;
  }
  /** Grant creation is ADMIN-ONLY; never expose it to untrusted GitHub workers. */
  createGrant({ grantId, binding, capUsd }) {
    const cap = parseCapUsd(capUsd);
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM budget_grants WHERE grant_id=?').get(ident(grantId, 'grant_id'))) {
        throw new Error('APES_BUDGET_DUPLICATE_GRANT');
      }
      this.db.prepare('INSERT INTO budget_grants (grant_id,binding_key,limit_micros) VALUES (?,?,?)')
        .run(grantId, bindingKey(assertBinding(binding)), cap);
      return this.snapshot(grantId, binding);
    });
  }
  /**
   * MOCK ONLY: consume a cryptographically verified owner approval and create
   * the REAL budget grant in one SQLite transaction. verifyApproval MUST be a
   * synchronous gateway-owned cryptographic validator, never an HTTP callback,
   * boolean supplied by a caller, or async function.
   */
  issueSignedGrant({ grantId, binding, capUsd, nonce, expiresAt, approval, verifyApproval }) {
    if (typeof verifyApproval !== 'function' || verifyApproval.constructor.name === 'AsyncFunction' ||
        typeof nonce !== 'string' || !GRANT_RE.test(nonce) ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('APES_BUDGET_APPROVAL_DENIED');
    }
    const run = assertBinding(binding);
    const cap = parseCapUsd(capUsd);
    const verdict = verifyApproval({ grantId, binding: run, capUsd, nonce, expiresAt, approval });
    if (verdict !== true) throw new Error('APES_BUDGET_APPROVAL_DENIED');
    return this.tx(() => {
      const claimed = this.db.prepare('INSERT OR IGNORE INTO approval_nonces (nonce,expires_at) VALUES (?,?)')
        .run(nonce, expiresAt);
      if (claimed.changes !== 1) throw new Error('APES_BUDGET_APPROVAL_REPLAY');
      this.db.prepare('INSERT INTO budget_grants (grant_id,binding_key,limit_micros) VALUES (?,?,?)')
        .run(ident(grantId, 'grant_id'), bindingKey(run), cap);
      return this.snapshot(grantId, run);
    });
  }
  /** Only a trusted gateway may supply quoteMicros (never accept user-provided quotes). */
  reserve({ grantId, binding, requestId, quoteMicros }) {
    ident(requestId, 'request_id'); micros(quoteMicros, 'quote');
    return this.tx(() => {
      const grant = this.authorize(grantId, binding);
      if (grant.state !== 'active') throw new Error('APES_BUDGET_GRANT_CLOSED');
      if (this.db.prepare('SELECT 1 FROM budget_requests WHERE grant_id=? AND request_id=?').get(grantId, requestId)) {
        throw new Error('APES_BUDGET_DUPLICATE_REQUEST');
      }
      const update = this.db.prepare(
        'UPDATE budget_grants SET reserved_micros=reserved_micros+? WHERE grant_id=? AND state=? AND used_micros+reserved_micros+? <= limit_micros'
      ).run(quoteMicros, grantId, 'active', quoteMicros);
      if (update.changes !== 1) throw new Error('APES_BUDGET_EXHAUSTED');
      this.db.prepare(
        'INSERT INTO budget_requests (grant_id,request_id,ceiling_micros,status) VALUES (?,?,?,?)'
      ).run(grantId, requestId, quoteMicros, 'reserved');
      return Object.freeze({ grantId, requestId, ceilingMicros: quoteMicros, status: 'reserved' });
    });
  }
  settle({ grantId, binding, requestId, verified, actualMicros }) {
    ident(requestId, 'request_id');
    if (typeof verified !== 'boolean') throw new Error('APES_BUDGET_INVALID_SETTLEMENT');
    return this.tx(() => {
      this.authorize(grantId, binding);
      const request = this.db.prepare(
        'SELECT * FROM budget_requests WHERE grant_id=? AND request_id=?'
      ).get(grantId, requestId);
      if (!request || request.status !== 'reserved') throw new Error('APES_BUDGET_INVALID_SETTLEMENT');
      const charge = verified ? micros(actualMicros, 'actual_cost', true) : request.ceiling_micros;
      if (charge > request.ceiling_micros) throw new Error('APES_BUDGET_CEILING_VIOLATION');
      const updated = this.db.prepare(
        'UPDATE budget_grants SET used_micros=used_micros+?,reserved_micros=reserved_micros-? WHERE grant_id=? AND reserved_micros >= ?'
      ).run(charge, request.ceiling_micros, grantId, request.ceiling_micros);
      if (updated.changes !== 1) throw new Error('APES_BUDGET_LEDGER_CORRUPT');
      this.db.prepare(
        'UPDATE budget_requests SET status=?,charged_micros=? WHERE grant_id=? AND request_id=?'
      ).run('settled', charge, grantId, requestId);
      return Object.freeze({ grantId, requestId, chargedMicros: charge, status: 'settled' });
    });
  }
  closeGrant(grantId, binding) {
    return this.tx(() => {
      this.authorize(grantId, binding);
      this.db.prepare('UPDATE budget_grants SET state=? WHERE grant_id=?').run('closed', grantId);
      return this.snapshot(grantId, binding);
    });
  }
  snapshot(grantId, binding) {
    const row = this.authorize(grantId, binding);
    return Object.freeze({
      grantId, state: row.state,
      limitMicros: row.limit_micros,
      usedMicros: row.used_micros,
      reservedMicros: row.reserved_micros,
      remainingMicros: row.limit_micros - row.used_micros - row.reserved_micros,
    });
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
module.exports = { SqliteBudgetStore };
