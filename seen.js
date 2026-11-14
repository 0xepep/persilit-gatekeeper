'use strict';

/**
 * seen.js — proof_tx seen-set: in-memory Set + JSON file persistence.
 *
 * Why persist: the process may restart between rounds (deploys, free-tier
 * sleep). A restart must NOT forget which proof_tx values were already
 * processed, or a replayed proof would be APPROVEd a second time.
 *
 * File format: {"version":1,"proof_tx":["0x...","0x..."]} — keys are
 * lower-cased. Writes are atomic-ish (write temp file, then rename).
 * If the file is corrupt/missing we start empty and log a warning —
 * fail-open on the store itself is unavoidable, but server.js logs it
 * loudly; the decision logic itself stays fail-closed.
 */
const fs = require('node:fs');
const path = require('node:path');

class SeenSet {
  constructor(filePath) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.set = new Set();
    if (this.filePath) this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(data) ? data : data.proof_tx;
      if (Array.isArray(list)) {
        for (const tx of list) {
          if (typeof tx === 'string' && tx) this.set.add(tx.trim().toLowerCase());
        }
      }
    } catch (err) {
      console.warn(`[seen] WARNING: could not load seen file ${this.filePath}: ${err.message} — starting empty.`);
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, proof_tx: [...this.set].sort() }, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[seen] WARNING: could not persist seen file ${this.filePath}: ${err.message}`);
    }
  }

  has(tx) {
    return typeof tx === 'string' && tx ? this.set.has(tx.trim().toLowerCase()) : false;
  }

  add(tx) {
    if (typeof tx !== 'string' || !tx) return false;
    const key = tx.trim().toLowerCase();
    const isNew = !this.set.has(key);
    this.set.add(key);
    if (isNew) this.save();
    return isNew;
  }

  get size() { return this.set.size; }
  list() { return [...this.set].sort(); }
}

module.exports = { SeenSet };
