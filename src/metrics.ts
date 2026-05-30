type Labels = Record<string, string>;

function labelStr(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return `{${pairs.join(',')}}`;
}

class Counter {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels?: Labels, by = 1) {
    const key = JSON.stringify(labels ?? {});
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${labelStr(JSON.parse(key) as Labels)} ${val}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  set(value: number, labels?: Labels) {
    this.values.set(JSON.stringify(labels ?? {}), value);
  }
  inc(labels?: Labels, by = 1) {
    const key = JSON.stringify(labels ?? {});
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  dec(labels?: Labels, by = 1) { this.inc(labels, -by); }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.values) {
      lines.push(`${this.name}${labelStr(JSON.parse(key) as Labels)} ${val}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

class Histogram {
  private bucketCounts = new Map<string, Map<number, number>>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();

  constructor(readonly name: string, readonly help: string, private buckets = DEFAULT_BUCKETS) {}

  observe(value: number, labels?: Labels) {
    const key = JSON.stringify(labels ?? {});
    if (!this.bucketCounts.has(key)) {
      this.bucketCounts.set(key, new Map(this.buckets.map(b => [b, 0])));
    }
    const bc = this.bucketCounts.get(key)!;
    for (const b of this.buckets) {
      if (value <= b) bc.set(b, (bc.get(b) ?? 0) + 1);
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, bc] of this.bucketCounts) {
      const labels = JSON.parse(key) as Labels;
      let cumulative = 0;
      for (const b of this.buckets) {
        cumulative += bc.get(b) ?? 0;
        lines.push(`${this.name}_bucket${labelStr({ ...labels, le: String(b) })} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${labelStr({ ...labels, le: '+Inf' })} ${this.counts.get(key) ?? 0}`);
      lines.push(`${this.name}_sum${labelStr(labels)} ${(this.sums.get(key) ?? 0).toFixed(6)}`);
      lines.push(`${this.name}_count${labelStr(labels)} ${this.counts.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  requestsTotal:    new Counter('turnq_requests_total',          'Total HTTP requests by method, path, and status'),
  activeChannels:   new Gauge('turnq_active_channels',           'Number of active channels'),
  queueDepth:       new Gauge('turnq_queue_depth',               'Current queue depth per channel'),
  activeConns:      new Gauge('turnq_active_connections',        'Active subscriber connections by transport type'),
  waitDuration:     new Histogram('turnq_wait_duration_seconds', 'Time from enqueue to turn grant per channel'),
  holdDuration:     new Histogram('turnq_hold_duration_seconds', 'Time from turn grant to release or expiry per channel'),
  timeoutsTotal:    new Counter('turnq_timeouts_total',          'Total timeouts by channel and reason'),

  expose(): string {
    return [
      this.requestsTotal,
      this.activeChannels,
      this.queueDepth,
      this.activeConns,
      this.waitDuration,
      this.holdDuration,
      this.timeoutsTotal,
    ].map(m => m.expose()).join('\n\n') + '\n';
  },
};
