// Clients des Web Workers : file d'attente, progression, annulation (terminate + recréation).

class WorkerClient {
  constructor(factory) {
    this.factory = factory;
    this.worker = null;
    this.pending = new Map();
    this.seq = 1;
    this.queue = Promise.resolve();
  }

  _ensure() {
    if (this.worker) return;
    this.worker = this.factory();
    this.worker.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.fraction, m.label);
      else if (m.type === 'done') { this.pending.delete(m.id); p.resolve(m.result); }
      else if (m.type === 'error') { this.pending.delete(m.id); p.reject(new Error(m.message)); }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Erreur dans le worker');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
  }

  /** Exécute un travail ; les travaux sont traités l'un après l'autre. */
  run(message, transfer = [], onProgress = null) {
    const job = () => new Promise((resolve, reject) => {
      this._ensure();
      const id = this.seq++;
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...message, id }, transfer);
    });
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Interrompt le travail en cours (le worker est détruit puis recréé au prochain appel). */
  cancel() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('Opération annulée.'));
    this.pending.clear();
  }
}

export const importer = new WorkerClient(() => new Worker(new URL('../io/importWorker.js', import.meta.url), { type: 'module' }));
export const geo = new WorkerClient(() => new Worker(new URL('../geo/geoWorker.js', import.meta.url), { type: 'module' }));
