/* ============================================================
   图片上传
   ------------------------------------------------------------
   三条硬规则：
     1) 类型由**魔数**判断，不看扩展名、不看 Content-Type。
        扩展名和 MIME 都是客户端说了算的，只有文件头不是。
     2) 文件名由服务端重新生成（slug 化 + 冲突计数），
        客户端给的名字只用来取一个"像样的词根"。
        这样 ../、绝对路径、ADS、保留设备名这些一次性全部失效。
     3) SVG 是唯一"能带脚本的图片"，进来必须过一遍标签白名单净化；
        净化失败就整张拒收，不做"尽力而为"的修补。
   ============================================================ */
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomToken, HttpError } from './util.mjs';

export const IMAGE_LIMITS = {
  bytes: 5 * 1024 * 1024,      // 单张 5 MB
  nameStem: 48,                // 词根最长 48 个字符
  svgNodes: 4000               // SVG 元素数上限，挡"巨大路径"型消耗
};

const sign = (buf, bytes) => Array.from(buf.slice(0, bytes));

/** 魔数判定 → 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | null */
export const sniffType = (buf) => {
  if (!buf || buf.length < 12) return null;
  const b = sign(buf, 12);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';

  /* SVG 是文本：看开头一段里有没有 <svg（可能带 XML 声明、注释、BOM） */
  const head = buf.slice(0, Math.min(buf.length, 2048)).toString('utf8')
    .replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
};

export const EXT = { png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp', svg: '.svg' };
export const MIME = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml'
};

/* ------------------------------------------------------------
   文件名
   ------------------------------------------------------------ */

/**
 * 把客户端给的名字压成一个安全词根：
 *   · 只保留字母/数字/汉字/连字符
 *   · 其余（含 . / \ : * ? " < > | 空格）一律换成 -
 *   · 折叠连续连字符、去掉首尾连字符、限长
 * 结果永远不会是 '.' '..' 或空串；空串兜底成 'image'。
 */
export const slugifyName = (raw, max) => {
  const base = String(raw || '')
    /* 只取路径的**最后一段**：'../../etc/passwd' → 'passwd'。
       不用"把分隔符替换成连字符"那种做法 —— 那会把目录名拼进文件名，
       既难看又毫无意义，而这里根本不需要保留目录信息。 */
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')      // 去掉扩展名（类型靠魔数，不靠它）
    .normalize('NFC');
  let out = '';
  for (const ch of base) {
    if (/[A-Za-z0-9\u4e00-\u9fa5-]/.test(ch)) out += ch;
    else out += '-';
  }
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  /* Windows 保留设备名：即便只是名字，也不留 */
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(out)) out = 'img-' + out;
  return out.slice(0, max || IMAGE_LIMITS.nameStem) || 'image';
};

/** 在 dir 下找一个不冲突的文件名：stem.ext → stem-2.ext → stem-3.ext … */
export const uniqueName = async (dir, stem, ext) => {
  let taken = new Set();
  try { taken = new Set(await readdir(dir)); } catch { /* 目录还不存在，随便用 */ }
  let name = stem + ext;
  let n = 2;
  while (taken.has(name)) {
    name = stem + '-' + n + ext;
    n++;
    if (n > 9999) { name = stem + '-' + randomToken(3) + ext; break; }
  }
  return name;
};

/* ------------------------------------------------------------
   SVG 净化
   ------------------------------------------------------------ */

const SVG_ALLOWED = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'filter',
  'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'feflood', 'femerge', 'femergenode',
  'fegaussianblur', 'fecomposite', 'fedropshadow', 'femorphology', 'feturbulence', 'fedisplacementmap',
  'image', 'style', 'marker', 'view'
]);

/* 注意这里**没有 /g**。
   带 /g 的正则用 .test() 会记忆 lastIndex，同一个标签里连续判断多个属性时
   会"隔一个跳一个"，第 2 个属性正好被跳过 —— style 的净化就是这么漏掉的。
   要么不带 g，要么每次 new 一个。这里选前者。 */
const SVG_ALLOWED_ATTR = /^(?:d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|viewbox|preserveaspectratio|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|stroke-dashoffset|stroke-opacity|opacity|transform|points|offset|stop-color|stop-opacity|gradientunits|gradienttransform|patternunits|patterncontentunits|clippathunits|maskunits|id|class|style|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|letter-spacing|xmlns|xmlns:xlink|version|role|aria-label|focusable|href|xlink:href|marker-end|marker-start|marker-mid|color|display|visibility)$/i;

/**
 * style 属性里有没有"危险写法"。
 * 逐项自检过：
 *   expression()、@import 直接判危险；
 *   url(#id) 放行（同文档内的渐变/图案引用，这是 SVG 的正常用法）；
 *   url(http…)、url(//…)、url(data…) 一律判危险。
 */
const cssIsDangerous = (value) => {
  const css = String(value || '');
  if (/expression\s*\(/i.test(css)) return true;
  if (/@import/i.test(css)) return true;
  const urls = css.match(/url\s*\([^)]*\)/gi) || [];
  return urls.some((u) => !/^url\s*\(\s*['"]?\s*#/i.test(u));
};

/**
 * 返回 { ok, svg, errors, warnings }
 * 用标签白名单重写整份 SVG：不在表里的元素整段丢掉（含内容），
 * 属性不在表里的丢掉；href 只允许 #fragment 和站内相对路径。
 */
export const sanitizeSvg = (text) => {
  const errors = [];
  const warnings = [];
  const src = String(text || '');
  const out = [];
  let nodes = 0;
  let dropped = 0;
  let skipDepth = 0;          // >0 表示正处在"被丢掉元素"的内部
  let skipName = '';

  /* 注释整段去掉：里面能藏条件注释之类的东西，而 SVG 不需要它们 */
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');

  const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m;
  let last = 0;

  while ((m = TAG.exec(clean))) {
    const between = clean.slice(last, m.index);
    /* 只有不在被丢元素内部时，两标签之间的文本才保留 */
    if (!skipDepth) out.push(between);
    last = TAG.lastIndex;

    const closing = m[1] === '/';
    const rawName = m[2];
    const name = rawName.toLowerCase().replace(/^svg:/, '');
    const attrRaw = m[3] || '';
    const selfClose = m[4] === '/';

    /* --- 跳过被丢元素的整棵子树（含其中的文本） --- */
    if (skipDepth) {
      if (closing && name === skipName) {
        skipDepth--;
        if (skipDepth === 0) skipName = '';
      } else if (!closing && !selfClose && name === skipName) {
        skipDepth++;
      }
      continue;
    }

    nodes++;
    if (nodes > IMAGE_LIMITS.svgNodes) {
      return { ok: false, errors: ['SVG 元素太多（超过 ' + IMAGE_LIMITS.svgNodes + ' 个）'], warnings };
    }

    if (!SVG_ALLOWED.has(name)) {
      dropped++;
      /* 整个子树都不要：<script>…</script> 里的代码、foreignObject 里的
         HTML 都算内容，只删标签会把它变成"裸文本"留在文件里 */
      if (!closing && !selfClose) { skipDepth = 1; skipName = name; }
      continue;
    }

    /* --- 属性过滤 --- */
    const kept = [];
    const ATTR = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let a;
    while ((a = ATTR.exec(attrRaw))) {
      const an = a[1];
      const av = a[2] === undefined ? null : a[2].replace(/^["']|["']$/g, '');
      if (/^on/i.test(an)) { dropped++; continue; }                      // 事件属性直接去
      if (/^(?:src|href|xlink:href|data|xlink:data)$/i.test(an) && av) {
        const v = av.trim();
        const safe = /^#/.test(v) || /^(?:\.{0,2}\/)?[\w\-./]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(v);
        if (!safe) { dropped++; continue; }                              // 外链一律去掉
      }
      /* 两道检查必须是"与"的关系，而且**各自独立生效**：
         白名单通过不等于内容安全 —— style 同时在白名单里，又可能是
         url(http://…) 这种会触发外部加载的写法。
         把两者塞进一个 if/else，通过白名单的那一支就再也查不到内容了，
         style 的净化正是这样漏掉的。 */
      if (!SVG_ALLOWED_ATTR.test(an)) { dropped++; continue; }
      if (av !== null && cssIsDangerous(av)) { dropped++; continue; }
      kept.push(av === null ? an : an + '="' + av.replace(/"/g, '&quot;') + '"');
    }

    out.push('<' + (closing ? '/' : '') + rawName +
      (closing ? '' : (kept.length ? ' ' + kept.join(' ') : '')) +
      (!closing && selfClose ? '/' : '') + '>');
  }
  if (!skipDepth) out.push(clean.slice(last));

  if (!/<svg[\s>]/i.test(clean)) errors.push('这不是一份 SVG（找不到 <svg>）');
  if (dropped) warnings.push('净化时丢掉了 ' + dropped + ' 处不安全的标签/属性');
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, svg: out.join(''), warnings };
};

/* ------------------------------------------------------------
   总入口
   ------------------------------------------------------------ */

const SIGNATURES = new Set(['png', 'jpeg', 'gif', 'webp']);

/**
 * 校验 + （必要时净化）→ 可落盘的字节
 * 返回 { type, ext, bytes, warnings }
 */
export const prepareImage = (buffer, clientName) => {
  if (!buffer || !buffer.length) throw new HttpError(422, '没有收到文件内容');
  if (buffer.length > IMAGE_LIMITS.bytes) {
    throw new HttpError(413, '图片超过 ' + Math.round(IMAGE_LIMITS.bytes / 1024 / 1024) + ' MB 上限');
  }

  const type = sniffType(buffer);
  if (!type) {
    throw new HttpError(422, '认不出这是什么图片（只支持 png / jpeg / gif / webp / svg，按文件内容判断）');
  }

  if (SIGNATURES.has(type)) {
    /* 位图：不做解码，只保证它是它声称的类型。真正的解码安全交给浏览器。 */
    return { type, ext: EXT[type], bytes: buffer, warnings: [] };
  }

  const result = sanitizeSvg(buffer.toString('utf8'));
  if (!result.ok) throw new HttpError(422, 'SVG 未通过安全检查：' + result.errors.join('；'));
  void clientName;
  return { type: 'svg', ext: EXT.svg, bytes: Buffer.from(result.svg, 'utf8'), warnings: result.warnings };
};

/** 落盘：目录固定，名字由服务端生成 */
export const saveImage = async (uploadsDir, buffer, clientName) => {
  const prepared = prepareImage(buffer, clientName);
  await mkdir(uploadsDir, { recursive: true });
  const stem = slugifyName(clientName);
  const name = await uniqueName(uploadsDir, stem, prepared.ext);
  await writeFile(join(uploadsDir, name), prepared.bytes, { mode: 0o644, flag: 'wx' });
  return {
    name,
    type: prepared.type,
    bytes: prepared.bytes.length,
    warnings: prepared.warnings,
    /* 相对仓库根的路径，直接可以写进 <img src> */
    src: 'img/uploads/' + name
  };
};
