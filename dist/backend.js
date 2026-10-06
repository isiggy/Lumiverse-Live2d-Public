// @bun
// node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]);
var fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0;i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1;i < 30; ++i) {
    for (var j = b[i];j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0;i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (;i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1;i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1;v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
};
var flt = new u8(288);
for (i = 0;i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144;i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256;i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280;i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0;i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1;i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l) {
    var bl = buf.length;
    if (l > bl) {
      var nbuf = new u8(Math.max(bl * 2, l));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, { l: lm, d: dm, m: lbt, n: dbt } = st;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0;i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0;i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (;; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (;bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (;bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder;
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {}
var dutf8 = function(d) {
  for (var r = "", i = 0;; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0;i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a = dutf8(dat), { s, r } = _a;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a[0], su = _a[1], off = _a[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (;b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (;b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0;i < c; ++i) {
    var _a = zh(data, o, z), c_2 = _a[0], sc = _a[1], su = _a[2], fn = _a[3], no = _a[4], off = _a[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/shared/settings.ts
var CLASSIFY_EXPRESSIONS = [
  "admiration",
  "amusement",
  "anger",
  "annoyance",
  "approval",
  "caring",
  "confusion",
  "curiosity",
  "desire",
  "disappointment",
  "disapproval",
  "disgust",
  "embarrassment",
  "excitement",
  "fear",
  "gratitude",
  "grief",
  "joy",
  "love",
  "nervousness",
  "optimism",
  "pride",
  "realization",
  "relief",
  "remorse",
  "sadness",
  "surprise",
  "neutral"
];
var FALLBACK_EXPRESSION = "joy";
var ID_PARAM_DEFAULT = {
  idParamAngleX: "ParamAngleX",
  idParamAngleY: "ParamAngleY",
  idParamAngleZ: "ParamAngleZ",
  idParamBodyAngleX: "ParamBodyAngleX",
  idParamBreath: "ParamBreath",
  idParamEyeBallX: "ParamEyeBallX",
  idParamEyeBallY: "ParamEyeBallY"
};
var CURSOR_PARAM_IDS = Object.keys(ID_PARAM_DEFAULT);
function defaultGlobalSettings() {
  return {
    enabled: true,
    followCursor: false,
    autoSendInteraction: false,
    backgroundMode: false,
    force_animation: false,
    force_loop: false,
    showFrames: false,
    expressionSource: "llm"
  };
}
function defaultSettings() {
  return {
    global: defaultGlobalSettings(),
    characterModelMapping: {},
    characterModelsSettings: {}
  };
}
function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object")
    return base;
  const value = raw;
  if (value.global && typeof value.global === "object") {
    base.global = { ...base.global, ...value.global };
  }
  if (value.characterModelMapping && typeof value.characterModelMapping === "object") {
    base.characterModelMapping = { ...value.characterModelMapping };
  }
  if (value.characterModelsSettings && typeof value.characterModelsSettings === "object") {
    base.characterModelsSettings = { ...value.characterModelsSettings };
  }
  return base;
}

// src/backend.ts
var SETTINGS_FILE = "settings.json";
var REGISTRY_FILE = "models.json";
var MODELS_DIR = "models";
var MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
var MAX_FILE_COUNT = 3000;
var CHUNK_BYTES = 1024 * 1024;
async function loadSettings(userId) {
  const raw = await spindle.userStorage.getJson(SETTINGS_FILE, {
    fallback: null,
    ...userId ? { userId } : {}
  });
  return normalizeSettings(raw);
}
async function saveSettings(settings, userId) {
  await spindle.userStorage.setJson(SETTINGS_FILE, settings, {
    indent: 2,
    ...userId ? { userId } : {}
  });
}
async function loadRegistry(userId) {
  const raw = await spindle.userStorage.getJson(REGISTRY_FILE, {
    fallback: [],
    ...userId ? { userId } : {}
  });
  return Array.isArray(raw) ? raw : [];
}
async function saveRegistry(models, userId) {
  await spindle.userStorage.setJson(REGISTRY_FILE, models, {
    indent: 2,
    ...userId ? { userId } : {}
  });
}
function send(payload, userId) {
  spindle.sendToFrontend(payload, userId);
}
function sanitizeZipPath(path) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/"))
    return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "" || part === "."))
    return null;
  if (parts.some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._")))
    return null;
  return parts.join("/");
}
function stripCommonRoot(paths) {
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  const first = [...roots][0];
  if (roots.size === 1 && first !== undefined && paths.every((path) => path.includes("/"))) {
    const prefix = first + "/";
    return (path) => path.slice(prefix.length);
  }
  return (path) => path;
}
function findModelSettingsFile(paths) {
  const model3 = paths.filter((path) => path.toLowerCase().endsWith(".model3.json")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (model3)
    return { path: model3, cubism: 4 };
  const model2 = paths.filter((path) => path.toLowerCase().endsWith(".model.json")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (model2)
    return { path: model2, cubism: 2 };
  return null;
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "model";
}
async function handleImportZip(msg, userId) {
  const upload = await spindle.uploads.get(msg.uploadId, userId);
  if (!upload) {
    send({ type: "import_error", error: "Upload not found or expired. Try again." }, userId);
    return;
  }
  try {
    let entries;
    try {
      entries = unzipSync(upload.data);
    } catch {
      send({ type: "import_error", error: "Could not read the ZIP archive." }, userId);
      return;
    }
    const cleaned = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      const path = sanitizeZipPath(rawPath);
      if (!path || data.length === 0)
        continue;
      cleaned.push({ path, data });
    }
    if (cleaned.length === 0) {
      send({ type: "import_error", error: "The ZIP archive is empty." }, userId);
      return;
    }
    if (cleaned.length > MAX_FILE_COUNT) {
      send({ type: "import_error", error: `Too many files in archive (max ${MAX_FILE_COUNT}).` }, userId);
      return;
    }
    const totalBytes = cleaned.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > MAX_UNPACKED_BYTES) {
      send({ type: "import_error", error: "Unpacked model exceeds the 512 MB limit." }, userId);
      return;
    }
    const strip = stripCommonRoot(cleaned.map((file) => file.path));
    const files = cleaned.map((file) => ({ path: strip(file.path), data: file.data })).filter((file) => file.path.length > 0);
    const settingsFile = findModelSettingsFile(files.map((file) => file.path));
    if (!settingsFile) {
      send({
        type: "import_error",
        error: "No Live2D settings file (*.model3.json or *.model.json) found in the archive."
      }, userId);
      return;
    }
    const registry = await loadRegistry(userId);
    const baseName = msg.name?.trim() || settingsFile.path.split("/").pop().replace(/\.model3?\.json$/i, "").replace(/\.model$/i, "") || upload.fileName.replace(/\.zip$/i, "");
    let id = slugify(baseName);
    let suffix = 2;
    while (registry.some((model) => model.id === id)) {
      id = `${slugify(baseName)}_${suffix++}`;
    }
    for (const file of files) {
      await spindle.userStorage.writeBinary(`${MODELS_DIR}/${id}/${file.path}`, file.data, userId);
    }
    const record = {
      id,
      name: baseName,
      settingsFile: settingsFile.path,
      cubism: settingsFile.cubism,
      sizeBytes: totalBytes,
      fileCount: files.length,
      importedAt: new Date().toISOString(),
      version: 1
    };
    registry.push(record);
    await saveRegistry(registry, userId);
    spindle.log.info(`live2d: imported model "${record.name}" (${files.length} files, ${totalBytes} bytes)`);
    send({ type: "model_imported", model: record }, userId);
    spindle.toast.success(`Live2D model "${record.name}" imported.`, userId ? { userId } : undefined);
  } finally {
    await spindle.uploads.delete(msg.uploadId, userId).catch(() => {});
  }
}
async function handleDeleteModel(modelId, userId) {
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === modelId);
  if (!record)
    return;
  const prefix = `${MODELS_DIR}/${modelId}/`;
  for (const key of [...fileCache.keys()]) {
    if (key.startsWith(`${userId}:${prefix}`))
      fileCache.delete(key);
  }
  const files = await spindle.userStorage.list(prefix, userId);
  for (const file of files) {
    await spindle.userStorage.delete(file, userId).catch(() => {});
  }
  await saveRegistry(registry.filter((model) => model.id !== modelId), userId);
  const settings = await loadSettings(userId);
  let changed = false;
  for (const [characterId, boundModel] of Object.entries(settings.characterModelMapping)) {
    if (boundModel === modelId) {
      delete settings.characterModelMapping[characterId];
      changed = true;
    }
  }
  if (changed)
    await saveSettings(settings, userId);
  send({ type: "model_deleted", modelId }, userId);
}
function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
var TRANSFER_IDLE_MS = 10 * 60 * 1000;
var FILE_CACHE_IDLE_MS = 60 * 1000;
var FILE_CACHE_MAX_ENTRIES = 3;
var transfers = new Map;
var fileCache = new Map;
function sweepTransferState(now) {
  for (const [key, session] of transfers) {
    if (now - session.lastUsed > TRANSFER_IDLE_MS)
      transfers.delete(key);
  }
  for (const [key, entry] of fileCache) {
    if (now - entry.lastUsed > FILE_CACHE_IDLE_MS)
      fileCache.delete(key);
  }
}
function readCachedFile(userId, path) {
  const key = `${userId}:${path}`;
  const now = Date.now();
  let entry = fileCache.get(key);
  if (!entry) {
    while (fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
      const oldest = [...fileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest)
        break;
      fileCache.delete(oldest[0]);
    }
    const bytes = spindle.userStorage.readBinary(path, userId);
    bytes.catch(() => fileCache.delete(key));
    entry = { bytes, lastUsed: now };
    fileCache.set(key, entry);
  }
  entry.lastUsed = now;
  return entry.bytes;
}
async function handleGetModelManifest(msg, userId) {
  sweepTransferState(Date.now());
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record) {
    send({ type: "model_files_error", reqId: msg.reqId, error: `Unknown model: ${msg.modelId}` }, userId);
    return;
  }
  const prefix = `${MODELS_DIR}/${record.id}/`;
  const listed = await spindle.userStorage.list(prefix, userId);
  const relative = listed.map((path) => path.startsWith(prefix) ? path.slice(prefix.length) : path).filter((path) => path.length > 0);
  const files = [];
  for (const path of relative) {
    const stat = await spindle.userStorage.stat(prefix + path, userId);
    if (stat.isFile)
      files.push({ path, size: stat.sizeBytes });
  }
  let presetSettings;
  const presetPath = relative.find((path) => path.toLowerCase().endsWith("sillytavern_settings.json"));
  if (presetPath) {
    try {
      presetSettings = JSON.parse(await spindle.userStorage.read(prefix + presetPath, userId));
    } catch {
      presetSettings = undefined;
    }
  }
  transfers.set(`${userId}:${msg.reqId}`, {
    prefix,
    files: new Set(files.map((file) => file.path)),
    lastUsed: Date.now()
  });
  send({
    type: "model_manifest",
    reqId: msg.reqId,
    modelId: record.id,
    version: record.version,
    settingsFile: record.settingsFile,
    cubism: record.cubism,
    chunkBytes: CHUNK_BYTES,
    files,
    ...presetSettings !== undefined ? { presetSettings } : {}
  }, userId);
}
async function handleGetModelChunk(msg, userId) {
  const session = transfers.get(`${userId}:${msg.reqId}`);
  if (!session || !session.files.has(msg.path)) {
    send({ type: "model_files_error", reqId: msg.reqId, error: "Transfer expired or unknown file; reload the model." }, userId);
    return;
  }
  session.lastUsed = Date.now();
  const bytes = await readCachedFile(userId, session.prefix + msg.path);
  const seq = Math.max(0, Math.floor(msg.seq));
  const slice = bytes.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, bytes.length));
  send({ type: "model_chunk", reqId: msg.reqId, path: msg.path, seq, dataB64: toBase64(slice) }, userId);
}
function trimToEndSentence(text) {
  const punctuation = new Set([".", "!", "?", "*", '"', ")", "}", "`", "]", "$", `
`]);
  for (let i = text.length - 1;i >= 0; i--) {
    const char = text[i];
    if (punctuation.has(char)) {
      return text.substring(0, i + 1).trimEnd();
    }
  }
  return text.trimEnd();
}
function trimToStartSentence(text) {
  const punctuation = new Set([".", "!", "?", "*", '"', ")", "}", "`", "]", "$", `
`]);
  for (let i = 0;i < text.length; i++) {
    if (punctuation.has(text[i])) {
      return text.substring(i + 1).trimStart();
    }
  }
  return text;
}
function sampleClassifyText(text) {
  let result = text.replace(/[\*\"]/g, "");
  const SAMPLE_THRESHOLD = 300;
  const HALF = SAMPLE_THRESHOLD / 2;
  if (text.length < SAMPLE_THRESHOLD) {
    result = trimToEndSentence(result);
  } else {
    result = trimToEndSentence(result.slice(0, HALF)) + " " + trimToStartSentence(result.slice(-HALF));
  }
  return result.trim();
}
async function classifyExpression(text) {
  if (!text || !spindle.permissions.has("generation"))
    return FALLBACK_EXPRESSION;
  const labels = CLASSIFY_EXPRESSIONS.join(", ");
  try {
    const result = await spindle.generate.quiet({
      type: "quiet",
      messages: [
        {
          role: "system",
          content: "You classify the dominant emotion of a roleplay message. " + `Respond with exactly one word from this list and nothing else: ${labels}.`
        },
        { role: "user", content: sampleClassifyText(text) }
      ],
      parameters: { max_tokens: 16, temperature: 0 }
    });
    const response = (result?.content ?? "").toLowerCase();
    const words = response.split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      if (CLASSIFY_EXPRESSIONS.includes(word))
        return word;
    }
    for (const label of CLASSIFY_EXPRESSIONS) {
      if (response.includes(label))
        return label;
    }
  } catch (error) {
    spindle.log.warn(`live2d: classification failed: ${String(error)}`);
  }
  return FALLBACK_EXPRESSION;
}
async function resolveChatCharacter(chatId, userId) {
  if (!spindle.permissions.has("chats"))
    return null;
  try {
    const chat = await spindle.chats.get(chatId, userId);
    return chat?.character_id ?? null;
  } catch {
    return null;
  }
}
async function handleCharacterMessageRendered(payload, userId) {
  const settings = await loadSettings(userId);
  if (!settings.global.enabled)
    return;
  const characterId = await resolveChatCharacter(payload.chatId, userId);
  let text = "";
  if (spindle.permissions.has("chat_mutation")) {
    try {
      const messages = await spindle.chat.getMessages(payload.chatId);
      const message = messages.find((entry) => entry.id === payload.messageId);
      if (message && !message.is_user)
        text = message.content ?? "";
    } catch (error) {
      spindle.log.warn(`live2d: could not read message: ${String(error)}`);
    }
  }
  send({
    type: "character_message",
    chatId: payload.chatId,
    characterId,
    messageId: payload.messageId,
    textLength: text.length
  }, userId);
  if (settings.global.expressionSource !== "llm")
    return;
  if (!text)
    return;
  const label = await classifyExpression(text);
  send({ type: "expression", chatId: payload.chatId, characterId, label, source: "llm" }, userId);
}
async function handleInteraction(msg, userId) {
  if (!spindle.permissions.has("chat_mutation")) {
    spindle.toast.warning('Grant the "Chat mutation" permission to send Live2D interaction messages.', userId ? { userId } : undefined);
    return;
  }
  try {
    await spindle.chat.appendMessage(msg.chatId, { role: "user", content: msg.message }, msg.generate ? { triggerGeneration: true } : undefined);
  } catch (error) {
    spindle.log.warn(`live2d: interaction failed: ${String(error)}`);
    spindle.toast.error(`Live2D interaction failed: ${String(error)}`, userId ? { userId } : undefined);
  }
}
async function sendState(userId) {
  const settings = await loadSettings(userId);
  const models = await loadRegistry(userId);
  let characters = [];
  if (spindle.permissions.has("characters")) {
    try {
      const { data } = await spindle.characters.list({ limit: 200, userId });
      characters = data.map((character) => ({ id: character.id, name: character.name }));
    } catch {
      characters = [];
    }
  }
  const permissions = await spindle.permissions.getGranted();
  send({ type: "state", settings, models, characters, permissions }, userId);
}
spindle.onFrontendMessage(async (payload, userId) => {
  const msg = payload;
  try {
    switch (msg.type) {
      case "get_state":
        await sendState(userId);
        break;
      case "save_settings":
        await saveSettings(normalizeSettings(msg.settings), userId);
        send({ type: "settings_saved" }, userId);
        break;
      case "import_model_zip":
        await handleImportZip(msg, userId);
        break;
      case "delete_model":
        await handleDeleteModel(msg.modelId, userId);
        break;
      case "get_model_manifest":
        await handleGetModelManifest(msg, userId);
        break;
      case "get_model_chunk":
        await handleGetModelChunk(msg, userId);
        break;
      case "interaction":
        await handleInteraction(msg, userId);
        break;
      case "classify_test": {
        const label = await classifyExpression(msg.text);
        send({ type: "classify_test_result", label }, userId);
        break;
      }
    }
  } catch (error) {
    spindle.log.error(`live2d: error handling ${msg?.type ?? "message"}: ${String(error)}`);
    if (msg?.type === "import_model_zip") {
      send({ type: "import_error", error: String(error) }, userId);
    } else if (msg?.type === "get_model_manifest" || msg?.type === "get_model_chunk") {
      send({ type: "model_files_error", reqId: msg.reqId, error: String(error) }, userId);
    }
  }
});
spindle.on("CHARACTER_MESSAGE_RENDERED", (payload, userId) => {
  const event = payload;
  if (!event?.chatId || !event?.messageId)
    return;
  handleCharacterMessageRendered(event, userId);
});
spindle.on("EXPRESSION_CHANGED", (payload, userId) => {
  const event = payload;
  if (!event?.chatId || !event?.label)
    return;
  (async () => {
    const settings = await loadSettings(userId);
    if (!settings.global.enabled || settings.global.expressionSource !== "native")
      return;
    send({
      type: "expression",
      chatId: event.chatId,
      characterId: event.characterId ?? null,
      label: event.label,
      source: "native"
    }, userId);
  })();
});
spindle.on("CHAT_SWITCHED", (payload, userId) => {
  const event = payload;
  (async () => {
    const characterId = event?.chatId ? await resolveChatCharacter(event.chatId, userId) : null;
    send({ type: "chat_context", chatId: event?.chatId ?? null, characterId }, userId);
  })();
});
spindle.permissions.onChanged(({ allGranted }) => {
  send({ type: "permissions_changed", permissions: allGranted });
});
spindle.commands.register([
  {
    id: "live2d-open-settings",
    label: "Live2D: Open Settings",
    description: "Open the Live2D Avatars settings tab",
    keywords: ["live2d", "avatar", "model", "settings"]
  },
  {
    id: "live2d-reload",
    label: "Live2D: Reload Models",
    description: "Reload all Live2D models on the stage",
    keywords: ["live2d", "reload", "reset"]
  },
  {
    id: "live2d-toggle",
    label: "Live2D: Toggle Enabled",
    description: "Enable or disable the Live2D avatar stage",
    keywords: ["live2d", "toggle", "enable", "disable"]
  }
]);
spindle.commands.onInvoked((commandId) => {
  (async () => {
    switch (commandId) {
      case "live2d-open-settings":
        send({ type: "focus_tab" });
        break;
      case "live2d-reload":
        send({ type: "reload_models" });
        break;
      case "live2d-toggle": {
        const settings = await loadSettings();
        settings.global.enabled = !settings.global.enabled;
        await saveSettings(settings);
        send({ type: "toggle_enabled", enabled: settings.global.enabled });
        spindle.toast.info(`Live2D ${settings.global.enabled ? "enabled" : "disabled"}.`);
        break;
      }
    }
  })();
});
spindle.log.info("live2d: backend ready");
