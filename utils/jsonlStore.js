const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

class JsonlStore {
  constructor(entityName) {
    this.entityName = entityName;
    this.filePath = path.join(DATA_DIR, `${entityName}.jsonl`);
    this.index = new Map();
    this._ensureFile();
    this._loadAll();
  }

  _ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf8');
    }
  }

  _loadAll() {
    this.index.clear();
    const content = fs.readFileSync(this.filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record._deleted) continue;
        if (record.id) {
          this.index.set(record.id, record);
        }
      } catch (e) {
        console.error(`Parse error in ${this.entityName}:`, line);
      }
    }
  }

  _append(record) {
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }

  create(record) {
    if (!record.id) {
      throw new Error('Record must have an id');
    }
    if (this.index.has(record.id)) {
      throw new Error(`Record with id ${record.id} already exists`);
    }
    record.createdAt = record.createdAt || new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    this._append(record);
    this.index.set(record.id, record);
    return record;
  }

  update(id, updates) {
    const existing = this.index.get(id);
    if (!existing) {
      throw new Error(`Record with id ${id} not found`);
    }
    const tombstone = { ...existing, _deleted: true, updatedAt: new Date().toISOString() };
    this._append(tombstone);
    this.index.delete(id);
    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    this._append(updated);
    this.index.set(id, updated);
    return updated;
  }

  delete(id) {
    const existing = this.index.get(id);
    if (!existing) return false;
    const tombstone = { ...existing, _deleted: true, updatedAt: new Date().toISOString() };
    this._append(tombstone);
    this.index.delete(id);
    return true;
  }

  findById(id) {
    return this.index.get(id) || null;
  }

  findAll() {
    return Array.from(this.index.values());
  }

  findOne(filter) {
    return this.findAll().find(record => this._matches(record, filter)) || null;
  }

  find(filter = {}) {
    return this.findAll().filter(record => this._matches(record, filter));
  }

  _matches(record, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') {
        if (value.$in) {
          if (!value.$in.includes(record[key])) return false;
        } else if (value.$gte) {
          if (new Date(record[key]) < new Date(value.$gte)) return false;
        } else if (value.$lte) {
          if (new Date(record[key]) > new Date(value.$lte)) return false;
        } else if (value.$gt) {
          if (new Date(record[key]) <= new Date(value.$gt)) return false;
        } else if (value.$lt) {
          if (new Date(record[key]) >= new Date(value.$lt)) return false;
        } else if (value.$ne) {
          if (record[key] === value.$ne) return false;
        } else if (value.$regex) {
          const re = new RegExp(value.$regex, value.$options || 'i');
          if (!re.test(String(record[key] || ''))) return false;
        }
      } else {
        if (record[key] !== value) return false;
      }
    }
    return true;
  }

  count(filter = {}) {
    return this.find(filter).length;
  }

  paginate(filter = {}, page = 1, pageSize = 20, sortBy = 'createdAt', sortOrder = 'desc') {
    let items = this.find(filter);
    items.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      if (sortOrder === 'asc') {
        return av > bv ? 1 : av < bv ? -1 : 0;
      }
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
    const total = items.length;
    const start = (page - 1) * pageSize;
    const data = items.slice(start, start + pageSize);
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }
}

const stores = {};

function getStore(entityName) {
  if (!stores[entityName]) {
    stores[entityName] = new JsonlStore(entityName);
  }
  return stores[entityName];
}

module.exports = { JsonlStore, getStore };
