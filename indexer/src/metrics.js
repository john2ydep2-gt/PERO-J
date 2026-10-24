/** Minimal Prometheus counter registry (text exposition format). */
const counters = new Map();

export function incCounter(name, help, labels = {}) {
  const c = counters.get(name) ?? { help, values: new Map() };
  const key = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, '\\$1')}"`)
    .join(',');
  c.values.set(key, (c.values.get(key) ?? 0) + 1);
  counters.set(name, c);
}

export function renderMetrics() {
  let out = '';
  for (const [name, { help, values }] of counters) {
    out += `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
    for (const [labels, v] of values)
      out += `${name}${labels ? `{${labels}}` : ''} ${v}\n`;
  }
  return out;
}

export function resetMetrics() {
  counters.clear();
}
