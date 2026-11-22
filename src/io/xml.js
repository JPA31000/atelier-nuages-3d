// Mini-analyseur XML sans DOMParser (indisponible dans un Web Worker).
// Suffisant pour le XML d'un fichier E57 : éléments, attributs, texte, CDATA.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

function stripNs(name) {
  const k = name.indexOf(':');
  return k >= 0 ? name.slice(k + 1) : name;
}

/** @returns {{name:string, attrs:Object, children:Array, text:string}} racine fictive "#root" */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let cur = root;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const t = text.slice(i, lt);
      if (t.trim()) cur.text += decode(t);
    }
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      cur.text += text.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      if (stack.length > 1) stack.pop();
      cur = stack[stack.length - 1];
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    // balise ouvrante : on cherche le '>' final en respectant les guillemets
    let j = lt + 1;
    let quote = 0;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (quote) { if (c === quote) quote = 0; }
      else if (c === 34 || c === 39) quote = c;
      else if (c === 62) break;
      j++;
    }
    let inner = text.slice(lt + 1, j);
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1);
    const sp = inner.search(/\s/);
    const name = stripNs(sp < 0 ? inner : inner.slice(0, sp));
    const attrs = {};
    if (sp >= 0) {
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let m;
      const attrText = inner.slice(sp);
      while ((m = re.exec(attrText))) {
        const k = m[1];
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        attrs[stripNs(k)] = decode(m[2] ?? m[3] ?? '');
      }
    }
    const node = { name, attrs, children: [], text: '' };
    cur.children.push(node);
    if (!selfClose) {
      stack.push(node);
      cur = node;
    }
    i = j + 1;
  }
  return root;
}

export const child = (node, name) => node?.children.find((c) => c.name === name) ?? null;
export const childrenNamed = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
export const text = (node, name) => {
  const c = name ? child(node, name) : node;
  return c ? c.text.trim() : '';
};
export const num = (node, name, def = null) => {
  const c = name ? child(node, name) : node;
  if (!c) return def;
  const v = parseFloat(c.text.trim());
  return Number.isFinite(v) ? v : def;
};
